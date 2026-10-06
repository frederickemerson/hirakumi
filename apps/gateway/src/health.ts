export type HealthState = "healthy" | "down";
export type HealthThresholds = { failsToDown: number; passesToHeal: number };
export type HealthReason = { op: string; reason: string };
export type HealthSnapshot = { health: HealthState; checkedAt: Date | null; lastReasons: HealthReason[]; failingSince: Date | null };
export type HealthTransition = {
  apiId: string; from: HealthState; to: HealthState; reasons: HealthReason[]; failingSince: Date | null; at: Date;
};

type Entry = { snap: HealthSnapshot; fails: number; passes: number };

/** In-memory health per API. Reads are O(1), so 503 answers never touch the DB or upstream. */
export class HealthTracker {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly t: HealthThresholds) {}

  seed(apiId: string, health: HealthState, checkedAt: Date | null): void {
    if (this.entries.has(apiId)) return;
    this.entries.set(apiId, { snap: { health, checkedAt, lastReasons: [], failingSince: null }, fails: 0, passes: 0 });
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
      e = { snap: { health: "healthy", checkedAt: null, lastReasons: [], failingSince: null }, fails: 0, passes: 0 };
      this.entries.set(apiId, e);
    }
    e.snap.checkedAt = at;
    if (passed) {
      e.passes += 1;
      e.fails = 0;
      e.snap.lastReasons = [];
      if (e.snap.health === "down" && e.passes >= this.t.passesToHeal) {
        e.snap.health = "healthy";
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
      return { apiId, from: "healthy", to: "down", reasons, failingSince: e.snap.failingSince, at };
    }
    return null;
  }
}
