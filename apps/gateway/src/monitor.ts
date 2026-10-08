import {
  insertCall, listDomainRecheckTargets, listMonitoredApiIds, recordDomainRecheck, scheduleDomainRecheck, type DomainRecheckOutcome,
  type DomainRecheckTarget, type DomainStatus, listOwnershipRecheckTargets, loadProbeInputs, recordHealthTransition, recordOwnershipRecheck,
  scheduleOwnershipRecheck, touchHealthCheck, type OwnershipRecheckOutcome, type OwnershipRecheckTarget, type Sql,
} from "@hirakumi/db";
import { OPERATOR_KEYS_UNAVAILABLE } from "@hirakumi/core";
import type { GatewayConfig } from "./config";
import type { HealthReason, HealthTracker, HealthTransition } from "./health";
import { isNoRecordError, matchVerifyTxt, type TxtLookup } from "@hirakumi/core";
import { addressResolverVia, checkRouted, type AddressResolver, type DomainRegistry } from "./domains";
import { probeVerifyDns, probeVerifyHeader, txtLookupVia, type DnsReason, type OwnershipReason } from "./ownership";
import { KEYS_UNAVAILABLE, type ApiRegistry } from "./registry";
import { runOperation } from "./upstream";

export type MonitorDeps = {
  sql: Sql; registry: ApiRegistry; health: HealthTracker;
  config: Pick<GatewayConfig, "probeIntervalMs" | "upstreamTimeoutMs" | "ownershipRecheckMs" | "ownershipRetryMs" | "dnsResolvers">
    & Partial<Pick<GatewayConfig, "edgeIps" | "domainRecheckMs">>;
  /** TXT lookups; unset: config.dnsResolvers. Tests pass a fake. */
  txtLookup?: TxtLookup;
  /** A, AAAA and CNAME lookups for the front-door re-check; unset: config.dnsResolvers. Tests pass a fake. */
  addressResolver?: AddressResolver;
  /** Front-door hosts, forgotten when a re-check changes one. */
  domains?: DomainRegistry;
  /** 0 to 1; tests pass a fixed value. */
  random?: () => number;
};

export type OwnershipRecheck = {
  outcome: OwnershipRecheckOutcome; reason: OwnershipReason | DnsReason; detail: string; failures: number; paused: boolean; changed: boolean;
};

/** The code was looked for and was not there, or another code was: the only outcomes that count toward a pause. */
const FAILED: (OwnershipReason | DnsReason)[] = ["missing", "mismatch"];

const WHERE = { dns: "the TXT record at _hirakumi.<your host>", header: "the X-Hirakumi-Verify header at its base URL" } as const;

const PAUSED_MESSAGE = (detail: string, kind: "dns" | "header" = "dns") =>
  `Hirakumi paused new sales of your API: two checks in a row did not find your code in ${WHERE[kind]} (${detail}). ` +
  `Buyers' credits they already bought still work. Put the ${kind === "dns" ? "record" : "header"} back, the same code as when you proved ownership, and sales start again at the next check.`;
const RESTORED_MESSAGE = (kind: "dns" | "header" = "dns") =>
  kind === "dns"
    ? "Your API's _hirakumi TXT record is back, so Hirakumi is selling it again."
    : "Your API's X-Hirakumi-Verify header is back, so Hirakumi is selling it again.";

/** What the seller is told when a front-door re-check changes their hostname's status. Plain words, no dashes. */
const DOMAIN_MESSAGES = (host: string, detail: string): Partial<Record<DomainStatus, string>> => ({
  disabled:
    `Hirakumi stopped answering ${host} for your API: two checks in a row did not find your code in the TXT record at _hirakumi.${host}. ` +
    `Callers there get an error now. Sales on Hirakumi's own URL go on. Put the record back and ${host} works again at the next check.`,
  detached:
    `${host} no longer points at Hirakumi (${detail}), so it is no longer your API's front door. Sales on Hirakumi's own URL go on. ` +
    "To use the front door again, open Protect your API and connect it again.",
  active: `Your _hirakumi TXT record for ${host} is back, so Hirakumi answers ${host} again.`,
});

/**
 * Rounds in a row in which every probe was rate limited (429) before one counts as failing: about 30 minutes at the
 * default interval. A drained quota is inconclusive, but an API that only ever answers 429 can't be sold either.
 */
export const RATE_LIMITED_ROUNDS_TO_FAIL = 15;
export const RATE_LIMITED_TOO_LONG_TEXT =
  "Your API answered every check with 429 (rate limited) for a long time, so Hirakumi can't tell whether it works. Raise the key's quota.";

export class Monitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly rotation = new Map<string, number>();
  private readonly rechecking = new Map<string, Promise<OwnershipRecheck | null>>();
  /** APIs already logged as blocked by the gateway's own key problem, so the log says it once per API. */
  private readonly operatorLogged = new Set<string>();
  /** Rounds in a row in which every probe of the API was rate limited. */
  private readonly rateLimitedRounds = new Map<string, number>();
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
      await this.recheckDomainsDue();
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
    // The gateway can't read keys: our problem, not the seller's. No upstream call is made; the API still turns Down
    // so nothing unusable is sold, and the coworker sends the seller no message for this reason.
    if (loaded.api.credentialError === KEYS_UNAVAILABLE) {
      if (!this.operatorLogged.has(apiId)) {
        this.operatorLogged.add(apiId);
        console.error(`[monitor] operator: keys unavailable (${apiId})`);
      }
      return this.record(apiId, [{ op: "*", reason: OPERATOR_KEYS_UNAVAILABLE }]);
    }
    this.operatorLogged.delete(apiId);
    const inputs = await loadProbeInputs(this.d.sql, apiId);
    const byOp = new Map<string, unknown[]>();
    for (const row of inputs) byOp.set(row.op_id, [...(byOp.get(row.op_id) ?? []), row.input]);

    let probed = 0;
    // An op answered 429 (rate limited) is neither a pass nor a fail: a drained quota must not gate sales.
    let inconclusive = 0;
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
      const rateLimited = outcome.result?.status === 429;
      // Stored as inconclusive (upstream_ok with verdict n/a: probed ops always have a promise, so only this gives
      // it), never as a failing check that a seller message or "first failed test" could quote.
      await insertCall(this.d.sql, {
        kind: "probe", apiId, opId, ruleId: op.ruleRow?.id ?? null, execution: outcome.execution,
        verdict: rateLimited ? "n/a" : outcome.verdict, reasons: outcome.reasons, latencyMs: outcome.latencyMs,
      });
      if (rateLimited) inconclusive += 1;
      else if (!(outcome.execution === "upstream_ok" && outcome.verdict === "pass")) {
        reasons.push(...(outcome.reasons.length ? outcome.reasons : [outcome.execution]).map((reason) => ({ op: opId, reason })));
      }
    }
    // Audit I4: an API we cannot check must not stay "Live". Say so instead of trusting it blindly.
    if (probed === 0) reasons.push({ op: "*", reason: "no saved test input for any enabled operation, so Hirakumi can't check this API" });
    // Every op was rate limited: nothing was learned, so health is left as it was, until that has gone on so long
    // that the API can't be sold either (RATE_LIMITED_ROUNDS_TO_FAIL); each round after that counts as failing.
    if (probed > 0 && inconclusive === probed) {
      const rounds = (this.rateLimitedRounds.get(apiId) ?? 0) + 1;
      this.rateLimitedRounds.set(apiId, rounds);
      if (rounds >= RATE_LIMITED_ROUNDS_TO_FAIL) return this.record(apiId, [{ op: "*", reason: RATE_LIMITED_TOO_LONG_TEXT }]);
      await touchHealthCheck(this.d.sql, apiId);
      return null;
    }
    this.rateLimitedRounds.delete(apiId);
    return this.record(apiId, reasons);
  }

  /** Feeds one probe round into the health tracker and stores a transition (or just the check time). */
  private async record(apiId: string, reasons: HealthReason[]): Promise<HealthTransition | null> {
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
   * Ownership re-check, for APIs proven with a DNS record or (before it) the X-Hirakumi-Verify header
   * (listOwnershipRecheckTargets). One seen for the first time is only scheduled, at a random time within one interval.
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
   * Front-door hosts, every domainRecheckMs (6 h) with jitter: the _hirakumi TXT at the host still holds the proven
   * code of an API on it, and an active host still resolves only to EDGE_IPS. Two TXT misses in a row disable the
   * host (421, no certificate); two "points elsewhere" detach it. A DNS timeout neither counts nor resets. None of
   * this touches sales on Hirakumi's own URLs.
   */
  async recheckDomainsDue(now: Date = new Date()): Promise<void> {
    const interval = this.d.config.domainRecheckMs ?? 6 * 3_600_000;
    let targets: DomainRecheckTarget[];
    try {
      targets = await listDomainRecheckTargets(this.d.sql);
    } catch (e) {
      console.error("[monitor] domain targets:", e);
      return;
    }
    for (const t of targets) {
      if (t.nextCheckAt === null) {
        const r = this.d.random?.() ?? Math.random();
        await scheduleDomainRecheck(this.d.sql, t.host, new Date(now.getTime() + Math.max(1, Math.round(interval * r))));
      } else if (t.nextCheckAt.getTime() <= now.getTime()) {
        await this.recheckDomain(t, now).catch((e) => console.error(`[monitor] domain ${t.host}:`, e));
      }
    }
  }

  async recheckDomain(t: DomainRecheckTarget, now: Date = new Date()): Promise<{ outcome: DomainRecheckOutcome; status: DomainStatus; changed: boolean }> {
    const interval = this.d.config.domainRecheckMs ?? 6 * 3_600_000;
    const lookup = this.d.txtLookup ?? txtLookupVia(this.d.config.dnsResolvers);
    let outcome: DomainRecheckOutcome = "pass";
    let detail = "";
    const name = `_hirakumi.${t.host}`;
    let records: string[][] | null = null;
    try {
      records = await lookup(name);
    } catch (e) {
      if (isNoRecordError(e)) records = [];
      else { outcome = "error"; detail = `DNS did not answer for ${name}.`; }
    }
    if (records && !t.codes.some((code) => matchVerifyTxt(records!, code) === "match")) {
      outcome = "txt_missing";
      detail = records.length ? `the TXT record at ${name} has no code of an API on this host` : `no TXT record at ${name}`;
    }
    if (outcome === "pass" && t.status !== "pending_dns") {
      const routed = await checkRouted(this.d.addressResolver ?? addressResolverVia(this.d.config.dnsResolvers), t.host, this.d.config.edgeIps ?? []);
      if (routed.outcome === "error") outcome = "error";
      else if (routed.outcome === "not_routed") outcome = "not_routed";
      detail = routed.detail;
    }
    const r = await recordDomainRecheck(this.d.sql, {
      host: t.host, outcome, detail, messages: DOMAIN_MESSAGES(t.host, detail),
      nextAt: this.nextAt(now, outcome === "pass" ? interval : this.d.config.ownershipRetryMs),
    });
    if (r.changed) {
      console.log(`[monitor] front door ${t.host} ${t.status} -> ${r.status} (${outcome})`);
      this.d.domains?.invalidate(t.host);
    }
    return { outcome, status: r.status, changed: r.changed };
  }

  /**
   * One re-check: the same lookup as the proof step (probeVerifyDns; probeVerifyHeader for APIs proven by header),
   * with the code the seller proved with. A missing record or another code counts; two in a row pause new sales
   * (402 offers, packs and Masumi jobs answer 503 selling_paused), and the code back ends the pause. Credits already bought keep working: their answers are
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
    const check = target.kind === "dns"
      ? await probeVerifyDns(target.origin, target.token, this.d.txtLookup ?? txtLookupVia(this.d.config.dnsResolvers))
      : await probeVerifyHeader(target, target.token, this.d.config.upstreamTimeoutMs);
    const outcome: OwnershipRecheckOutcome = check.ok ? "pass" : FAILED.includes(check.reason) ? "fail" : "error";
    const r = await recordOwnershipRecheck(this.d.sql, {
      apiId, outcome, detail: check.detail,
      nextAt: this.nextAt(now, outcome === "pass" ? this.d.config.ownershipRecheckMs : this.d.config.ownershipRetryMs),
      pausedMessage: PAUSED_MESSAGE(check.detail, target.kind), restoredMessage: RESTORED_MESSAGE(target.kind),
    });
    if (r.changed) {
      console.log(`[monitor] ${apiId} ownership ${r.paused ? "paused" : "restored"} (${check.reason})`);
      await this.d.registry.get(apiId, { fresh: true });
    }
    return { outcome, reason: check.reason, detail: check.detail, ...r };
  }
}
