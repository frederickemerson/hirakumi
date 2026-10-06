import { describe, expect, it } from "vitest";
import { settlementLine } from "./settlement";

describe("settlementLine", () => {
  it("names the mode and the reasons", () => {
    expect(settlementLine({ mode: "escrow", reasons: ["new seller"] })).toBe("Settlement: escrow, because: new seller");
    expect(settlementLine({ mode: "direct", reasons: ["small pack", "proven seller"] })).toBe("Settlement: direct, because: small pack, proven seller");
  });
  it("without reasons (a fixed PACK_MODE) names only the mode", () => {
    expect(settlementLine({ mode: "direct", reasons: [] })).toBe("Settlement: direct");
  });
  it("says when escrow was recommended but the gateway settles direct", () => {
    expect(settlementLine({ mode: "direct", reasons: ["large pack"], recommended: "escrow" })).toBe("Settlement: direct (escrow recommended, because: large pack)");
  });
});
