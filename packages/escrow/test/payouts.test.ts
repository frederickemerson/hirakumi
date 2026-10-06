import { describe, expect, it } from "vitest";
import { closePayouts, settleObligations } from "../src/index.js";
import { BUYER, FEE, SELLER, goldenDatum } from "./golden.js";

// Same numbers as split_* tests in contracts/pack-escrow/lib/hirakumi/escrow.test.ak.
describe("closePayouts — the on-chain split() arithmetic", () => {
  const d = goldenDatum();

  it("62 of 100 at 20 000 with 3%", () => {
    expect(closePayouts(d, 2_000_000n, 62n)).toEqual({
      sellerGross: 1_240_000n,
      seller: 1_202_800n,
      fee: 37_200n,
      buyer: 760_000n,
    });
  });

  it("rounds the fee down", () => {
    expect(closePayouts({ ...d, pricePerCall: 333n }, 2_000_000n, 1n)).toMatchObject({
      seller: 324n,
      fee: 9n,
      buyer: 1_999_667n,
    });
  });

  it("clamps feeBps to 0…1000 instead of rejecting", () => {
    expect(closePayouts({ ...d, feeBps: 5000n }, 2_000_000n, 62n)).toMatchObject({ seller: 1_116_000n, fee: 124_000n });
    expect(closePayouts({ ...d, feeBps: -1n }, 2_000_000n, 62n)).toMatchObject({ seller: 1_240_000n, fee: 0n });
  });

  it("caps the seller's gross at the locked tokens and never goes negative", () => {
    expect(closePayouts(d, 1_000_000n, 62n)).toEqual({ sellerGross: 1_000_000n, seller: 970_000n, fee: 30_000n, buyer: 0n });
    expect(closePayouts({ ...d, pricePerCall: -20_000n }, 2_000_000n, 62n)).toEqual({
      sellerGross: 0n,
      seller: 0n,
      fee: 0n,
      buyer: 2_000_000n,
    });
  });

  it("0 accepted pays everything to the buyer; donated tokens go to the buyer", () => {
    expect(closePayouts(d, 2_000_000n, 0n)).toEqual({ sellerGross: 0n, seller: 0n, fee: 0n, buyer: 2_000_000n });
    expect(closePayouts(d, 2_500_000n, 62n).buyer).toBe(1_260_000n);
  });

  it("accepts number counts", () => {
    expect(closePayouts(d, 2_000_000n, 62).seller).toBe(1_202_800n);
  });
});

describe("settleObligations — what Settle checks, aggregated per address", () => {
  const closing = { ...goldenDatum(), stage: { kind: "closing" as const, accepted: 62n, contestEnd: 0n } };

  it("three distinct addresses", () => {
    expect(settleObligations(closing, { tokens: 2_000_000n, lovelace: 2_000_000n }, 400_000n)).toEqual([
      { address: SELLER, tokens: 1_202_800n, lovelace: 0n },
      { address: FEE, tokens: 37_200n, lovelace: 0n },
      { address: BUYER, tokens: 760_000n, lovelace: 1_600_000n },
    ]);
  });

  it("merges seller == buyer into one obligation", () => {
    expect(
      settleObligations({ ...closing, seller: BUYER }, { tokens: 2_000_000n, lovelace: 2_000_000n }, 400_000n),
    ).toEqual([
      { address: BUYER, tokens: 1_962_800n, lovelace: 1_600_000n },
      { address: FEE, tokens: 37_200n, lovelace: 0n },
    ]);
  });

  it("merges fee == seller and drops zero obligations", () => {
    expect(
      settleObligations({ ...closing, feeAddress: SELLER }, { tokens: 2_000_000n, lovelace: 2_000_000n }, 400_000n),
    ).toEqual([
      { address: SELLER, tokens: 1_240_000n, lovelace: 0n },
      { address: BUYER, tokens: 760_000n, lovelace: 1_600_000n },
    ]);
    const zero = { ...closing, stage: { kind: "closing" as const, accepted: 0n, contestEnd: 0n } };
    expect(settleObligations(zero, { tokens: 2_000_000n, lovelace: 2_000_000n }, 400_000n)).toEqual([
      { address: BUYER, tokens: 2_000_000n, lovelace: 1_600_000n },
    ]);
  });

  it("refuses a datum that isn't Closing", () => {
    expect(() => settleObligations(goldenDatum(), { tokens: 1n, lovelace: 1n }, 0n)).toThrow(/Closing/);
  });
});
