import {
  insertCall, listMonitoredApiIds, listOwnershipRecheckTargets, loadProbeInputs, recordHealthTransition, recordOwnershipRecheck,
  scheduleOwnershipRecheck, touchHealthCheck, type OwnershipRecheckOutcome, type OwnershipRecheckTarget, type Sql,
} from "@hirakumi/db";
import type { GatewayConfig } from "./config";
import type { HealthReason, HealthTracker, HealthTransition } from "./health";
import { probeVerifyHeader, type OwnershipReason } from "./ownership";
import type { ApiRegistry } from "./registry";
import { runOperation } from "./upstream";

export type MonitorDeps = {
  sql: Sql; registry: ApiRegistry; health: HealthTracker;
  config: Pick<GatewayConfig, "probeIntervalMs" | "upstreamTimeoutMs" | "ownershipRecheckMs" | "ownershipRetryMs">;
  /** 0 to 1; tests pass a fixed value. */
  random?: () => number;
};

export type OwnershipRecheck = {
  outcome: OwnershipRecheckOutcome; reason: OwnershipReason; detail: string; failures: number; paused: boolean; changed: boolean;
};

/** The header was looked for and was not there, or held another code: the only outcomes that count toward a pause. */
const FAILED: OwnershipReason[] = ["missing", "mismatch"];

export const PAUSED_MESSAGE = (detail: string) =>
  `Hirakumi paused new sales of your API: two checks in a row did not find your code in the X-Hirakumi-Verify header at its base URL (${detail}). ` +
  "Buyers' credits they already bought still work. Send the header again, the same code as when you proved ownership, and sales start again at the next check.";
export const RESTORED_MESSAGE = "Your API's X-Hirakumi-Verify header is back, so Hirakumi is selling it again.";

export class Monitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly rotation = new Map<string, number>();
  private readonly rechecking = new Map<string, Promise<OwnershipRecheck | null>>();
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
      await this.recheckDue();
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

  /** next = now + interval, jittered by up to 10% either way, so checks of many APIs spread out. */
  private nextAt(now: Date, intervalMs: number): Date {
    const r = this.d.random?.() ?? Math.random();
    return new Date(now.getTime() + Math.round(intervalMs * (0.9 + 0.2 * r)));
  }

  /**
   * Ownership re-check, for APIs proven with the X-Hirakumi-Verify header only (listOwnershipRecheckTargets). One
   * seen for the first time is only scheduled, at a random time within one interval.
   */
  async recheckDue(now: Date = new Date()): Promise<void> {
    let targets: OwnershipRecheckTarget[];
    try {
      targets = await listOwnershipRecheckTargets(this.d.sql);
    } catch (e) {
      console.error("[monitor] ownership targets:", e);
      return;
    }
    for (const t of targets) {
      if (t.next_check_at === null) {
        const r = this.d.random?.() ?? Math.random();
        await scheduleOwnershipRecheck(this.d.sql, t.id, new Date(now.getTime() + Math.max(1, Math.round(this.d.config.ownershipRecheckMs * r))));
      } else if (t.next_check_at.getTime() <= now.getTime()) {
        await this.recheckOwnership(t.id, now).catch((e) => console.error(`[monitor] ownership ${t.id}:`, e));
      }
    }
  }

  /**
   * One re-check: the same request as the proof step (probeVerifyHeader), with the code the seller proved with. A
   * missing header or another code counts; two in a row pause new sales (402 offers, packs and Masumi jobs answer
   * 503 selling_paused), and the header back ends the pause. Credits already bought keep working: their answers are
   * still checked against the promise, and stopping them would strand what buyers paid for. A network error neither
   * counts nor resets. Two calls for one API at once share one check.
   */
  recheckOwnership(apiId: string, now: Date = new Date()): Promise<OwnershipRecheck | null> {
    const running = this.rechecking.get(apiId);
    if (running) return running;
    const p = this.recheckOnce(apiId, now).finally(() => this.rechecking.delete(apiId));
    this.rechecking.set(apiId, p);
    return p;
  }

  private async recheckOnce(apiId: string, now: Date): Promise<OwnershipRecheck | null> {
    const target = (await listOwnershipRecheckTargets(this.d.sql)).find((t) => t.id === apiId);
    if (!target) return null;
    const check = await probeVerifyHeader(target, target.token, this.d.config.upstreamTimeoutMs);
    const outcome: OwnershipRecheckOutcome = check.ok ? "pass" : FAILED.includes(check.reason) ? "fail" : "error";
    const r = await recordOwnershipRecheck(this.d.sql, {
      apiId, outcome, detail: check.detail,
      nextAt: this.nextAt(now, outcome === "pass" ? this.d.config.ownershipRecheckMs : this.d.config.ownershipRetryMs),
      pausedMessage: PAUSED_MESSAGE(check.detail), restoredMessage: RESTORED_MESSAGE,
    });
    if (r.changed) {
      console.log(`[monitor] ${apiId} ownership ${r.paused ? "paused" : "restored"} (${check.reason})`);
      await this.d.registry.get(apiId, { fresh: true });
    }
    return { outcome, reason: check.reason, detail: check.detail, ...r };
  }
}
