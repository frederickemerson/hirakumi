import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { jcs as referenceJcs } from "@x402/cardano";
import { jcs } from "../src/jcs";
import { inputHash, outputHash } from "../src/hashing";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("jcs (RFC 8785)", () => {
  it("sorts keys, drops undefined, keeps arrays in order, normalises -0", () => {
    expect(jcs({ b: 2, a: [1, "x", null, true], c: { z: 1.5e-7, y: -0, u: undefined } }))
      .toBe('{"a":[1,"x",null,true],"b":2,"c":{"y":0,"z":1.5e-7}}');
  });
  it("matches @x402/cardano's jcs on a mixed corpus (the Masumi reference)", () => {
    const corpus: unknown[] = [
      { symbol: "ADA", n: 10, nested: { "é": 1, z: 2, "€": 3, a: [] } },
      [{ key: "symbol", value: "ADA" }, { key: "limit", value: 5 }],
      { big: 1e21, small: 1e-7, int: 42, neg: -3.25, s: "quote\" back\\ ctrl\u0001 emoji😀" },
      "plain", 0, true, null,
    ];
    for (const v of corpus) expect(jcs(v)).toBe(referenceJcs(v));
  });
  it("rejects non-finite numbers", () => {
    expect(() => jcs({ x: Number.NaN })).toThrow(/non-finite/);
  });
});

describe("MIP-004 hashing", () => {
  it("inputHash = sha256(identifier + ';' + jcs(input))", () => {
    expect(inputHash("abc123", { symbol: "ADA", a: 1 })).toBe(sha('abc123;{"a":1,"symbol":"ADA"}'));
  });
  it("outputHash = sha256(identifier + ';' + raw)", () => {
    expect(outputHash("abc123", '{"price":1}')).toBe(sha('abc123;{"price":1}'));
  });
});
