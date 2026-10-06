import { describe, expect, it } from "vitest";
import { DEFAULT_SETTLEMENT_POLICY, chooseSettlement, uptimeFraction, type SettlementInput } from "../src/settlement";

const proven: SettlementInput = { priceMicros: 1_000_000n, sellerUptime7d: 1, listingAgeDays: 30, buyerCanEscrow: true };
const DAY = 86_400_000;

describe("chooseSettlement (PACK_MODE=hybrid)", () => {
  it("direct for a small pack from a proven seller", () => {
    expect(chooseSettlement(proven)).toEqual({ mode: "direct", reasons: ["small pack", "proven seller"] });
  });

  it("direct when the buyer can't escrow, whatever else is true", () => {
    const risky = { priceMicros: 9_000_000n, sellerUptime7d: 0.5, listingAgeDays: 0, buyerCanEscrow: false };
    expect(chooseSettlement(risky)).toEqual({ mode: "direct", reasons: ["buyer sent no receipt key"] });
  });

  it.each([
    ["at the large pack threshold", { priceMicros: 2_000_000n }, ["large pack"]],
    ["above it", { priceMicros: 5_000_000n }, ["large pack"]],
    ["uptime below 99%", { sellerUptime7d: 0.9899 }, ["uptime below 99%"]],
    ["a listing younger than 7 days", { listingAgeDays: 6.99 }, ["new seller"]],
  ] as const)("escrow %s", (_name, over, reasons) => {
    expect(chooseSettlement({ ...proven, ...over })).toEqual({ mode: "escrow", reasons });
  });

  it("stays direct exactly at 99% uptime and 7 days, and just below 2 tUSDM", () => {
    expect(chooseSettlement({ ...proven, priceMicros: 1_999_999n, sellerUptime7d: 0.99, listingAgeDays: 7 }).mode).toBe("direct");
  });

  it("lists every reason, in a fixed order", () => {
    const all = { priceMicros: 3_000_000n, sellerUptime7d: 0.5, listingAgeDays: 1, buyerCanEscrow: true };
    expect(chooseSettlement(all)).toEqual({ mode: "escrow", reasons: ["large pack", "uptime below 99%", "new seller"] });
  });

  it("takes its thresholds from the policy", () => {
    const policy = { escrowFromMicros: 10_000_000n, minUptimePct: 95, minListingDays: 1 };
    expect(chooseSettlement({ ...proven, priceMicros: 5_000_000n, sellerUptime7d: 0.96, listingAgeDays: 2 }, policy).mode).toBe("direct");
    expect(chooseSettlement({ ...proven, sellerUptime7d: 0.94 }, policy)).toEqual({ mode: "escrow", reasons: ["uptime below 95%"] });
  });

  it("escrow whenever the buyer asks for it, that reason first", () => {
    expect(chooseSettlement({ ...proven, buyerWantsEscrow: true })).toEqual({ mode: "escrow", reasons: ["buyer asked for escrow"] });
    const all = { priceMicros: 3_000_000n, sellerUptime7d: 0.5, listingAgeDays: 1, buyerCanEscrow: true, buyerWantsEscrow: true };
    expect(chooseSettlement(all).reasons).toEqual(["buyer asked for escrow", "large pack", "uptime below 99%", "new seller"]);
  });

  it("a buyer who asks for escrow without keys still can't escrow (the gateway refuses that request first)", () => {
    expect(chooseSettlement({ ...proven, buyerCanEscrow: false, buyerWantsEscrow: true }).mode).toBe("direct");
  });

  it("defaults to 2 tUSDM, 99% and 7 days", () => {
    expect(DEFAULT_SETTLEMENT_POLICY).toEqual({ escrowFromMicros: 2_000_000n, minUptimePct: 99, minListingDays: 7 });
  });
});

describe("uptimeFraction (health_events transitions)", () => {
  const from = new Date("2026-10-01T00:00:00Z");
  const to = new Date(from.getTime() + 7 * DAY);
  const at = (days: number) => new Date(from.getTime() + days * DAY);

  it("is 1 with no transitions and a healthy start", () => {
    expect(uptimeFraction({ from, to, startHealth: "healthy", events: [] })).toBe(1);
  });

  it("is 0 when down for the whole window", () => {
    expect(uptimeFraction({ from, to, startHealth: "down", events: [] })).toBe(0);
  });

  it("subtracts each down interval", () => {
    const events = [{ to: "down", at: at(1) }, { to: "healthy", at: at(1.7) }, { to: "down", at: at(6.3) }] as const;
    // down 0.7 d + 0.7 d of 7 d
    expect(uptimeFraction({ from, to, startHealth: "healthy", events: [...events] })).toBeCloseTo(0.8, 10);
  });

  it("counts a start in the down state until the first recovery", () => {
    expect(uptimeFraction({ from, to, startHealth: "down", events: [{ to: "healthy", at: at(0.07) }] })).toBeCloseTo(0.99, 10);
  });

  it("ignores events outside the window and sorts the rest", () => {
    const events = [{ to: "healthy", at: at(3.5) }, { to: "down", at: at(-1) }, { to: "down", at: at(3) }, { to: "down", at: at(9) }] as const;
    expect(uptimeFraction({ from, to, startHealth: "healthy", events: [...events] })).toBeCloseTo(1 - 0.5 / 7, 10);
  });

  it("is 1 for an empty window", () => {
    expect(uptimeFraction({ from: to, to: from, startHealth: "down", events: [] })).toBe(1);
  });
});
