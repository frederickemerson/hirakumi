import { describe, expect, it } from "vitest";
import { buildBuyerSnippet } from "./snippet";

const input = {
  gatewayBaseUrl: "https://api.hirakumi.app/", apiId: "api_1", packId: "pk_1", packCalls: 100,
  packPriceMicros: "2000000", opId: "getPrice", method: "GET",
};

describe("buildBuyerSnippet", () => {
  it("is a standard @x402/fetch client in under 20 lines (US6)", () => {
    const code = buildBuyerSnippet(input);
    expect(code.split("\n").length).toBeLessThanOrEqual(20);
    expect(code).toContain('import { wrapFetchWithPayment, x402Client } from "@x402/fetch";');
    expect(code).toContain("npm i @x402/fetch@2.26.0 @x402/cardano@2.26.0");
    expect(code).toContain('const base = "https://api.hirakumi.app/a/api_1";');
    expect(code).toContain("${base}/packs/pk_1");
    expect(code).toContain("${base}/x/getPrice");
    expect(code).toContain("Authorization: `Bearer ${token}`");
  });

  it("caps spending at exactly one pack, because the x402 client's default cap is $1", () => {
    expect(buildBuyerSnippet(input)).toContain('.setSpendControls({ maxAmountPerPayment: "$2" })');
    expect(buildBuyerSnippet({ ...input, packPriceMicros: "2500000" })).toContain('maxAmountPerPayment: "$2.5"');
  });

  it("sends a JSON body for non-GET operations", () => {
    const code = buildBuyerSnippet({ ...input, method: "POST", opId: "quote" });
    expect(code).toContain('method: "POST"');
    expect(code).toContain("body: JSON.stringify(input)");
    expect(code.split("\n").length).toBeLessThanOrEqual(20);
  });

  it("reads a text answer as text, and a JSON answer as JSON", () => {
    expect(buildBuyerSnippet(input)).toContain("await res.json());");
    const code = buildBuyerSnippet({ ...input, textAnswer: true });
    expect(code).toContain("await res.text());");
    expect(code).not.toContain("await res.json());");
  });
});
