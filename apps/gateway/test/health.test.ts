import { describe, expect, it } from "vitest";
import { HealthTracker } from "../src/health";

const r = [{ op: "getPrice", reason: "/price is missing" }];
const t = (s: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, s));

describe("HealthTracker (demo thresholds 2/2)", () => {
  it("goes Down after 2 consecutive failures and remembers when failing started", () => {
    const h = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    expect(h.record("api_a", false, r, t(0))).toBeNull();
    const tr = h.record("api_a", false, r, t(10));
    expect(tr).toEqual({ apiId: "api_a", from: "healthy", to: "down", reasons: r, failingSince: t(0), at: t(10) });
    expect(h.get("api_a")).toMatchObject({ health: "down", checkedAt: t(10), lastReasons: r, failingSince: t(0) });
  });
  it("a pass in between resets the failure run", () => {
    const h = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    h.record("api_a", false, r, t(0));
    h.record("api_a", true, [], t(10));
    expect(h.record("api_a", false, r, t(20))).toBeNull();
    expect(h.get("api_a")?.health).toBe("healthy");
  });
  it("needs 2 consecutive passes to come back", () => {
    const h = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    h.record("api_a", false, r, t(0));
    h.record("api_a", false, r, t(10));
    expect(h.record("api_a", true, [], t(20))).toBeNull();
    expect(h.record("api_a", true, [], t(30))).toEqual({ apiId: "api_a", from: "down", to: "healthy", reasons: [], failingSince: null, at: t(30) });
    expect(h.get("api_a")).toMatchObject({ health: "healthy", failingSince: null, lastReasons: [] });
  });
  it("production thresholds need 3 failures", () => {
    const h = new HealthTracker({ failsToDown: 3, passesToHeal: 2 });
    h.record("api_a", false, r); h.record("api_a", false, r);
    expect(h.get("api_a")?.health).toBe("healthy");
    expect(h.record("api_a", false, r)?.to).toBe("down");
  });
  it("seed keeps DB state unless already tracked; reset forgets", () => {
    const h = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    h.seed("api_a", "down", t(0));
    h.seed("api_a", "healthy", null);
    expect(h.get("api_a")?.health).toBe("down");
    h.reset("api_a");
    expect(h.get("api_a")).toBeUndefined();
  });
});
