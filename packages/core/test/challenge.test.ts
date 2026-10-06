import { describe, expect, it } from "vitest";
import { buildWalletChallenge, type WalletChallengeFields } from "../src/challenge";

const fields: WalletChallengeFields = {
  domain: "hirakumi.vercel.app", sellerId: "sel_abcdefghij", apiId: "api_abcdefghij",
  origin: "https://price.example.dev", payTo: "addr_test1qpexample", network: "cardano:preprod",
  nonce: "n0nce", expires: "2026-10-06T12:30:00.000Z",
};

describe("challenge", () => {
  it("builds a stable line-based message", () => {
    expect(buildWalletChallenge(fields)).toBe([
      "Hirakumi ownership proof",
      "domain: hirakumi.vercel.app",
      "seller: sel_abcdefghij",
      "api: api_abcdefghij",
      "origin: https://price.example.dev",
      "payTo: addr_test1qpexample",
      "network: cardano:preprod",
      "nonce: n0nce",
      "expires: 2026-10-06T12:30:00.000Z",
    ].join("\n"));
  });
  it("refuses line breaks (no field can forge another line)", () => {
    expect(() => buildWalletChallenge({ ...fields, origin: "https://a\npayTo: addr_test1evil" })).toThrow(/line break/);
  });
  it("refuses mainnet addresses", () => {
    expect(() => buildWalletChallenge({ ...fields, payTo: "addr1qxyz" })).toThrow(/addr_test1/);
  });
});
