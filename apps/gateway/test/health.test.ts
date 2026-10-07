import { describe, expect, it } from "vitest";
import { OPERATOR_KEYS_UNAVAILABLE } from "@hirakumi/core";
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

describe("HealthTracker: an operator-only Down re-blamed on the seller (audit 3)", () => {
  const op = [{ op: "*", reason: OPERATOR_KEYS_UNAVAILABLE }];
  const operatorDown = (h: HealthTracker) => {
    for (let i = 0; i < 3; i++) h.record("api_a", false, op, t(i));
    expect(h.get("api_a")?.health).toBe("down");
  };

  it("writes a down to down transition only after failsToDown seller-reason rounds in a row, once", () => {
    const h = new HealthTracker({ failsToDown: 3, passesToHeal: 2 });
    operatorDown(h);
    expect(h.record("api_a", false, r, t(10))).toBeNull();
    expect(h.record("api_a", false, r, t(20))).toBeNull();
    expect(h.record("api_a", false, r, t(30))).toEqual({ apiId: "api_a", from: "down", to: "down", reasons: r, failingSince: t(10), at: t(30) });
    // Said once: further failures stay quiet.
    for (let i = 4; i < 9; i++) expect(h.record("api_a", false, r, t(i * 10))).toBeNull();
  });

  it("a single seller-reason round, or one broken by a pass or by our own reason, re-blames nothing", () => {
    const h = new HealthTracker({ failsToDown: 3, passesToHeal: 2 });
    operatorDown(h);
    expect(h.record("api_a", false, r, t(10))).toBeNull();
    expect(h.record("api_a", true, [], t(20))).toBeNull();
    expect(h.record("api_a", false, r, t(30))).toBeNull();
    expect(h.record("api_a", false, op, t(40))).toBeNull();
    expect(h.record("api_a", false, r, t(50))).toBeNull();
    expect(h.record("api_a", false, r, t(55))).toBeNull();
  });

  it("a seller Down is never re-blamed; a reloaded tracker remembers an operator-only Down from the stored reasons", () => {
    const seller = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    seller.record("api_a", false, r, t(0));
    seller.record("api_a", false, r, t(1));
    for (let i = 2; i < 8; i++) expect(seller.record("api_a", false, r, t(i))).toBeNull();

    const reloaded = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    reloaded.seed("api_a", "down", t(0), [{ op: "*", reason: OPERATOR_KEYS_UNAVAILABLE, since: null }]);
    expect(reloaded.record("api_a", false, r, t(1))).toBeNull();
    expect(reloaded.record("api_a", false, r, t(2))).toMatchObject({ from: "down", to: "down", failingSince: t(1) });

    const sellerSeed = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    sellerSeed.seed("api_a", "down", t(0), r);
    for (let i = 1; i < 5; i++) expect(sellerSeed.record("api_a", false, r, t(i))).toBeNull();
  });
});
