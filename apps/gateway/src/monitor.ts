import { insertCall, listMonitoredApiIds, loadProbeInputs, recordHealthTransition, touchHealthCheck, type Sql } from "@hirakumi/db";
import type { GatewayConfig } from "./config";
import type { HealthReason, HealthTracker, HealthTransition } from "./health";
import type { ApiRegistry } from "./registry";
import { runOperation } from "./upstream";

export type MonitorDeps = {
  sql: Sql; registry: ApiRegistry; health: HealthTracker;
  config: Pick<GatewayConfig, "probeIntervalMs" | "upstreamTimeoutMs">;
};

export class Monitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly rotation = new Map<string, number>();
  constructor(private readonly d: MonitorDeps) {}

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, this.d.config.probeIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return; // a slow upstream must not stack probes
    this.running = true;
    try {
      const ids = await listMonitoredApiIds(this.d.sql);
      await Promise.all(ids.map((id) => this.probeApi(id).catch((e) => console.error(`[monitor] ${id}:`, e))));
    } catch (e) {
      // A background loop must never reject: Node would exit and the health counters would be lost.
      console.error("[monitor] tick failed:", e);
    } finally {
      this.running = false;
    }
  }

  async probeApi(apiId: string): Promise<HealthTransition | null> {
    const loaded = await this.d.registry.get(apiId);
    if (!loaded) return null;
    const inputs = await loadProbeInputs(this.d.sql, apiId);
    const byOp = new Map<string, unknown[]>();
    for (const row of inputs) byOp.set(row.op_id, [...(byOp.get(row.op_id) ?? []), row.input]);

    let probed = 0;
    const reasons: HealthReason[] = [];
    for (const [opId, list] of byOp) {
      const op = loaded.ops.get(opId);
      if (!op || !op.rule || !op.row.enabled) continue;
      const key = `${apiId}:${opId}`;
      const idx = (this.rotation.get(key) ?? 0) % list.length;
      this.rotation.set(key, idx + 1);
      const checked = op.validateInput(list[idx]);
      const input = checked.ok ? checked.value : (list[idx] as Record<string, unknown>);
      const outcome = await runOperation(loaded.api, op, input, { timeoutMs: this.d.config.upstreamTimeoutMs, probe: true });
      probed += 1;
      await insertCall(this.d.sql, {
        kind: "probe", apiId, opId, ruleId: op.ruleRow?.id ?? null, execution: outcome.execution,
        verdict: outcome.verdict, reasons: outcome.reasons, latencyMs: outcome.latencyMs,
      });
      if (!(outcome.execution === "upstream_ok" && outcome.verdict === "pass")) {
        reasons.push(...(outcome.reasons.length ? outcome.reasons : [outcome.execution]).map((reason) => ({ op: opId, reason })));
      }
    }
    // Audit I4: an API we cannot check must not stay "Live". Say so instead of trusting it blindly.
    if (probed === 0) reasons.push({ op: "*", reason: "no saved test input for any enabled operation, so Hirakumi can't check this API" });

    const t = this.d.health.record(apiId, reasons.length === 0, reasons);
    if (t) {
      const since = t.failingSince?.toISOString() ?? null;
      await recordHealthTransition(this.d.sql, apiId, t.from, t.to, t.reasons.map((r) => ({ ...r, since })));
      console.log(`[monitor] ${apiId} ${t.from} → ${t.to}${t.reasons[0] ? ` (${t.reasons[0].op}: ${t.reasons[0].reason})` : ""}`);
    } else {
      await touchHealthCheck(this.d.sql, apiId);
    }
    return t;
  }
}
