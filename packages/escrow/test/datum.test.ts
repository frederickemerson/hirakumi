import { describe, expect, it } from "vitest";
import { PACK_ESCROW, decodePackDatum, encodePackDatum, validateDatumForLock, type PackDatum } from "../src/index.js";
import {
  BUYER,
  FEE,
  GOLDEN_CLOSING_CBOR,
  GOLDEN_OPEN_CBOR,
  SCRIPT_ADDR,
  SELLER,
  goldenDatum,
} from "./golden.js";

const closing = (): PackDatum => ({
  ...goldenDatum(),
  stage: { kind: "closing", accepted: 62n, contestEnd: 1_791_234_567_890n },
});

describe("encodePackDatum — golden vectors from Aiken cbor.serialise", () => {
  it("Open stage, base address with stake part + enterprise addresses", () => {
    expect(encodePackDatum(goldenDatum())).toBe(GOLDEN_OPEN_CBOR);
  });

  it("Closing stage", () => {
    expect(encodePackDatum(closing())).toBe(GOLDEN_CLOSING_CBOR);
  });
});

describe("decodePackDatum", () => {
  it("round-trips both stages", () => {
    expect(decodePackDatum(GOLDEN_OPEN_CBOR)).toEqual(goldenDatum());
    expect(decodePackDatum(GOLDEN_CLOSING_CBOR)).toEqual(closing());
  });

  it("round-trips a script-credential address (so a bad lock can still be inspected)", () => {
    const d = { ...goldenDatum(), seller: SCRIPT_ADDR };
    expect(decodePackDatum(encodePackDatum(d))).toEqual(d);
  });

  it("normalises hex case", () => {
    expect(decodePackDatum(GOLDEN_OPEN_CBOR.toUpperCase())).toEqual(goldenDatum());
  });

  it("rejects data that isn't a PackDatum", () => {
    expect(() => decodePackDatum("d8799fff")).toThrow(); // Constr 0 []
    expect(() => decodePackDatum("d87a80")).toThrow(); // Constr 1 []
    expect(() => decodePackDatum("4100")).toThrow(); // bytes
    // Stage Constr 2 []
    expect(() => decodePackDatum(GOLDEN_OPEN_CBOR.slice(0, -"d87980ff".length) + "d87b80ff")).toThrow();
    // Closing with one field
    expect(() => decodePackDatum(GOLDEN_OPEN_CBOR.slice(0, -"d87980ff".length) + "d87a9f183effff")).toThrow();
  });
});

describe("encodePackDatum input checks", () => {
  it("rejects malformed hex / addresses / negative-looking stage values", () => {
    expect(() => encodePackDatum({ ...goldenDatum(), channelId: "xyz" })).toThrow();
    expect(() => encodePackDatum({ ...goldenDatum(), seller: "addr_test1nope" })).toThrow();
  });
});

describe("validateDatumForLock", () => {
  const ok = goldenDatum();
  const lock = { priceMicros: 2_000_000n };
  const bad = (patch: Partial<PackDatum>, l = lock) => () => validateDatumForLock({ ...ok, ...patch }, l);

  it("accepts the golden datum", () => {
    expect(() => validateDatumForLock(ok, lock)).not.toThrow();
  });

  it("allows equal seller / refund / fee addresses (the validator aggregates per address)", () => {
    expect(bad({ seller: BUYER, feeAddress: BUYER })).not.toThrow();
    expect(bad({ feeAddress: SELLER })).not.toThrow();
  });

  it("rejects script-credential refund, seller or fee addresses", () => {
    expect(bad({ buyerRefund: SCRIPT_ADDR })).toThrow(/buyerRefund/);
    expect(bad({ seller: SCRIPT_ADDR })).toThrow(/seller/);
    expect(bad({ feeAddress: SCRIPT_ADDR })).toThrow(/feeAddress/);
  });

  it("rejects a refund (or any payout) address equal to the escrow address", () => {
    expect(bad({ buyerRefund: PACK_ESCROW.address })).toThrow(/buyerRefund/);
    expect(bad({ seller: PACK_ESCROW.address })).toThrow(/seller/);
  });

  it("rejects mainnet addresses", () => {
    expect(
      bad({ seller: "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8" }),
    ).toThrow(/seller/);
  });

  it("rejects ids of the wrong length", () => {
    expect(bad({ channelId: "00".repeat(31) })).toThrow(/channelId/);
    expect(bad({ receiptKey: "00".repeat(33) })).toThrow(/receiptKey/);
    expect(bad({ ruleHash: "ab".repeat(31) })).toThrow(/ruleHash/);
    expect(bad({ closer: "c1".repeat(32) })).toThrow(/closer/);
    expect(bad({ policyId: "e6".repeat(27) })).toThrow(/policyId/);
    expect(bad({ assetName: "00".repeat(33) })).toThrow(/assetName/);
  });

  it("rejects a receipt key no on-chain IOU can be valid for (small order, mixed order, non-canonical)", () => {
    expect(bad({ receiptKey: "01" + "00".repeat(31) })).toThrow(/receiptKey is not a usable ed25519 key/);
    expect(bad({ receiptKey: "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a" })).toThrow(/receiptKey/);
    expect(bad({ receiptKey: "f0" + "ff".repeat(30) + "7f" })).toThrow(/receiptKey/);
  });

  it("rejects a price that doesn't divide exactly or doesn't match pricePerCall", () => {
    expect(bad({}, { priceMicros: 2_000_001n })).toThrow(/divide/);
    expect(bad({ pricePerCall: 19_999n })).toThrow(/pricePerCall/);
    expect(bad({ pricePerCall: 0n, maxCalls: 100n }, { priceMicros: 0n })).toThrow();
    expect(bad({ maxCalls: 0n })).toThrow(/maxCalls/);
  });

  it("rejects feeBps outside 0…1000", () => {
    expect(bad({ feeBps: -1n })).toThrow(/feeBps/);
    expect(bad({ feeBps: 1001n })).toThrow(/feeBps/);
    expect(bad({ feeBps: 0n })).not.toThrow();
    expect(bad({ feeBps: 1000n })).not.toThrow();
  });

  it("rejects contestPeriod outside 60 000 ms…30 days", () => {
    expect(bad({ contestPeriod: 59_999n })).toThrow(/contestPeriod/);
    expect(bad({ contestPeriod: 30n * 86_400_000n + 1n })).toThrow(/contestPeriod/);
    expect(bad({ contestPeriod: 60_000n })).not.toThrow();
    expect(bad({ contestPeriod: 30n * 86_400_000n })).not.toThrow();
  });

  it("rejects a closeFeeBudget too small to ever settle, or absurdly large", () => {
    expect(bad({ closeFeeBudget: 499_999n })).toThrow(/closeFeeBudget/);
    expect(bad({ closeFeeBudget: 2_000_001n })).toThrow(/closeFeeBudget/);
  });

  it("rejects a lock that isn't Open", () => {
    expect(bad({ stage: { kind: "closing", accepted: 0n, contestEnd: 0n } })).toThrow(/Open/);
  });

  it("checks the datum round-trips through CBOR", () => {
    expect(() => validateDatumForLock(decodePackDatum(encodePackDatum(ok)), lock)).not.toThrow();
  });

  it("uses a fee address that is a real key address", () => {
    expect(bad({ feeAddress: FEE })).not.toThrow();
  });
});
