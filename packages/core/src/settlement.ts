// PACK_MODE=hybrid: per pack purchase, settle direct (pay the seller) or in escrow (lock at pack_escrow), and say why.

export type SettlementMode = "direct" | "escrow";
export type Settlement = { mode: SettlementMode; reasons: string[] };

/** Thresholds (gateway config). A pack at or above escrowFromMicros, uptime below minUptimePct, or a younger listing: escrow. */
export type SettlementPolicy = { escrowFromMicros: bigint; minUptimePct: number; minListingDays: number };
export const DEFAULT_SETTLEMENT_POLICY: SettlementPolicy = { escrowFromMicros: 2_000_000n, minUptimePct: 99, minListingDays: 7 };
/** Uptime is measured over this many days of health_events. */
export const UPTIME_WINDOW_DAYS = 7;

export type SettlementInput = {
  priceMicros: bigint;
  /** 0..1, share of the last UPTIME_WINDOW_DAYS the API was not Down. */
  sellerUptime7d: number;
  listingAgeDays: number;
  /** The buyer sent a receipt key and a refund address. Without both, escrow is impossible. */
  buyerCanEscrow: boolean;
};

/**
 * The policy. Pure: same input, same answer. Reasons are plain strings shown to buyers, in a fixed order.
 * A buyer who can't escrow gets direct with only that reason, so the answer never depends on time-varying inputs.
 */
export function chooseSettlement(i: SettlementInput, p: SettlementPolicy = DEFAULT_SETTLEMENT_POLICY): Settlement {
  if (!i.buyerCanEscrow) return { mode: "direct", reasons: ["buyer sent no receipt key"] };
  const reasons: string[] = [];
  if (i.priceMicros >= p.escrowFromMicros) reasons.push("large pack");
  if (i.sellerUptime7d * 100 < p.minUptimePct) reasons.push(`uptime below ${p.minUptimePct}%`);
  if (i.listingAgeDays < p.minListingDays) reasons.push("new seller");
  return reasons.length ? { mode: "escrow", reasons } : { mode: "direct", reasons: ["small pack", "proven seller"] };
}

export type HealthState = "healthy" | "down";

/**
 * Share of [from, to] the API was not Down, from health_events transitions. `startHealth` is the state at `from`
 * (the last transition before it, else the listing's initial "healthy"). Events outside the window are ignored.
 */
export function uptimeFraction(w: { from: Date; to: Date; startHealth: HealthState; events: { to: HealthState; at: Date }[] }): number {
  const start = w.from.getTime();
  const end = w.to.getTime();
  if (end <= start) return 1;
  const events = w.events
    .map((e) => ({ to: e.to, t: e.at.getTime() }))
    .filter((e) => e.t > start && e.t <= end)
    .sort((a, b) => a.t - b.t);
  let state = w.startHealth;
  let since = start;
  let down = 0;
  for (const e of events) {
    if (state === "down") down += e.t - since;
    state = e.to;
    since = e.t;
  }
  if (state === "down") down += end - since;
  return 1 - down / (end - start);
}
