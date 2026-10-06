import { describe, expect, it } from "vitest";
import { assetName, offerHeadline, parseOffer } from "./offer";

/* The live demo API's 402 body, as the gateway sent it on 6 Oct 2026. */
const LIVE_402 = {
  error: "credits_required",
  packs: [{
    packId: "pk_7a6rr2uygn",
    calls: 100,
    price: "2000000",
    asset: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d",
    buyUrl: "https://52-70-235-103.sslip.io/a/api_eejiaioyqt/packs/pk_7a6rr2uygn",
  }],
  ruleHash: "sha256:cafe20dd5a17a437eac09440de1d4bf5f2bd25abc6fbabe8f41ecd39e7e95798",
  ruleUrl: "https://52-70-235-103.sslip.io/r/sha256:cafe20dd5a17a437eac09440de1d4bf5f2bd25abc6fbabe8f41ecd39e7e95798",
};

describe("parseOffer", () => {
  it("reads the packs from the 402 fields, price in micros", () => {
    const offer = parseOffer(LIVE_402)!;
    expect(offer.packs).toHaveLength(1);
    expect(offerHeadline(offer.packs[0])).toBe("2 tUSDM · 100 calls");
    expect(offer.packs[0].buyUrl).toBe(LIVE_402.packs[0].buyUrl);
    expect(offer.ruleUrl).toBe(LIVE_402.ruleUrl);
  });

  it("formats fractional prices without floats", () => {
    expect(offerHeadline(parseOffer({ packs: [{ ...LIVE_402.packs[0], price: "2500000", calls: 50 }] })!.packs[0])).toBe("2.5 tUSDM · 50 calls");
  });

  it("returns null for anything that is not an offer", () => {
    expect(parseOffer("Payment required")).toBeNull();
    expect(parseOffer({ error: "credits_required" })).toBeNull();
    expect(parseOffer({ packs: [{ calls: "100" }] })).toBeNull();
  });
});

describe("assetName", () => {
  it("decodes the token name with or without a dot and the CIP-67 label", () => {
    expect(assetName(LIVE_402.packs[0].asset)).toBe("tUSDM");
    expect(assetName("16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d")).toBe("tUSDM");
    expect(assetName("16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde")).toBe("tokens");
  });
});
