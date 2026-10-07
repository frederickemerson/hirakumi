import { isOperatorOnly } from "@hirakumi/core";

export type HealthState = "healthy" | "down";
export type HealthThresholds = { failsToDown: number; passesToHeal: number };
export type HealthReason = { op: string; reason: string };
export type HealthSnapshot = { health: HealthState; checkedAt: Date | null; lastReasons: HealthReason[]; failingSince: Date | null };
/**
 * A change of health, or (from "down" to "down") a change of who is to blame: an API Down only for Hirakumi's own key
 * problem (OPERATOR_KEYS_UNAVAILABLE, no seller message) that then fails failsToDown rounds in a row for the
 * seller's reasons. The coworker messages the seller about that one like any Down.
 */
export type HealthTransition = {
  apiId: string; from: HealthState; to: HealthState; reasons: HealthReason[]; failingSince: Date | null; at: Date;
};

/**
 * operatorDown: Down only for our key problem so far. sellerFails / sellerSince: the seller-reason rounds in a row
 * since, and when the first of them was.
 */
type Entry = { snap: HealthSnapshot; fails: number; passes: number; operatorDown: boolean; sellerFails: number; sellerSince: Date | null };

/** In-memory health per API. Reads are O(1), so 503 answers never touch the DB or upstream. */
export class HealthTracker {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly t: HealthThresholds) {}

  /** downReasons: the reasons of the event that made it Down (stored), so an operator-only Down stays one. */
  seed(apiId: string, health: HealthState, checkedAt: Date | null, downReasons: unknown = null): void {
    if (this.entries.has(apiId)) return;
    this.entries.set(apiId, {
      snap: { health, checkedAt, lastReasons: [], failingSince: null }, fails: 0, passes: 0,
      ...noOperatorDown(), operatorDown: health === "down" && isOperatorOnly(downReasons),
    });
  }

  reset(apiId: string): void {
    this.entries.delete(apiId);
  }

  get(apiId: string): HealthSnapshot | undefined {
    return this.entries.get(apiId)?.snap;
  }

  record(apiId: string, passed: boolean, reasons: HealthReason[], at: Date = new Date()): HealthTransition | null {
    let e = this.entries.get(apiId);
    if (!e) {
      e = { snap: { health: "healthy", checkedAt: null, lastReasons: [], failingSince: null }, fails: 0, passes: 0, ...noOperatorDown() };
      this.entries.set(apiId, e);
    }
    e.snap.checkedAt = at;
    if (passed) {
      e.passes += 1;
      e.fails = 0;
      e.snap.lastReasons = [];
      Object.assign(e, { sellerFails: 0, sellerSince: null });
      if (e.snap.health === "down" && e.passes >= this.t.passesToHeal) {
        e.snap.health = "healthy";
        e.operatorDown = false;
        e.snap.failingSince = null;
        return { apiId, from: "down", to: "healthy", reasons: [], failingSince: null, at };
      }
      if (e.snap.health === "healthy") e.snap.failingSince = null;
      return null;
    }
    e.fails += 1;
    e.passes = 0;
    e.snap.lastReasons = reasons;
    if (e.fails === 1 && e.snap.health === "healthy") e.snap.failingSince = at;
    if (e.snap.health === "healthy" && e.fails >= this.t.failsToDown) {
      e.snap.health = "down";
      e.operatorDown = isOperatorOnly(reasons);
      return { apiId, from: "healthy", to: "down", reasons, failingSince: e.snap.failingSince, at };
    }
    if (e.snap.health === "down" && e.operatorDown) {
      if (isOperatorOnly(reasons)) {
        Object.assign(e, { sellerFails: 0, sellerSince: null });
        return null;
      }
      e.sellerFails += 1;
      e.sellerSince ??= at;
      if (e.sellerFails >= this.t.failsToDown) {
        const failingSince = e.sellerSince;
        Object.assign(e, noOperatorDown());
        return { apiId, from: "down", to: "down", reasons, failingSince, at };
      }
    }
    return null;
  }
}

const noOperatorDown = () => ({ operatorDown: false, sellerFails: 0, sellerSince: null as Date | null });
