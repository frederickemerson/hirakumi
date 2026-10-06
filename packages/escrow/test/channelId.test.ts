import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveChannelId } from "../src/index.js";
import { BUYER, GOLDEN_PK } from "./golden.js";

const base = { apiId: "api_1", packId: "pk_1", receiptKey: GOLDEN_PK, refundAddress: BUYER, quoteNonce: "11".repeat(16) };

describe("deriveChannelId", () => {
  it("is 32 bytes of hex and deterministic", () => {
    const a = deriveChannelId(base);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveChannelId({ ...base })).toBe(a);
  });

  it("is sha256 over length-prefixed fields (pinned vector)", () => {
    const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
    const field = (b: Buffer) => Buffer.concat([u16(b.length), b]);
    const addrBytes = Buffer.from(
      // header 0x00 = base address (key payment, key stake), network 0
      "00b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5",
      "hex",
    );
    const expected = createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from("hk-channel"),
          field(Buffer.from("api_1")),
          field(Buffer.from("pk_1")),
          Buffer.from(GOLDEN_PK, "hex"),
          field(addrBytes),
          Buffer.from("11".repeat(16), "hex"),
        ]),
      )
      .digest("hex");
    expect(deriveChannelId(base)).toBe(expected);
  });

  it("changes with every input, and can't be forged by shifting bytes between ids", () => {
    const a = deriveChannelId(base);
    expect(deriveChannelId({ ...base, apiId: "api_2" })).not.toBe(a);
    expect(deriveChannelId({ ...base, packId: "pk_2" })).not.toBe(a);
    expect(deriveChannelId({ ...base, quoteNonce: "22".repeat(16) })).not.toBe(a);
    expect(deriveChannelId({ ...base, receiptKey: "00".repeat(32) })).not.toBe(a);
    expect(deriveChannelId({ ...base, apiId: "api_1p", packId: "k_1" })).not.toBe(a);
  });

  it("rejects malformed inputs", () => {
    expect(() => deriveChannelId({ ...base, receiptKey: "00" })).toThrow();
    expect(() => deriveChannelId({ ...base, quoteNonce: "11".repeat(15) })).toThrow();
    expect(() => deriveChannelId({ ...base, refundAddress: "nope" })).toThrow();
  });
});
