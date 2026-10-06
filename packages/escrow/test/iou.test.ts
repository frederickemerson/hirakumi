import { describe, expect, it } from "vitest";
import { newReceiptKey, parseIouHeader, receiptMessage, signReceipt, verifyReceipt } from "../src/index.js";
import { CHANNEL, GOLDEN_PK, GOLDEN_SK, IOU_7_MESSAGE, SIG_7 } from "./golden.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("receiptMessage (IOU bytes)", () => {
  it("is 44 bytes: HKR1 ‖ channel ‖ u64be(accepted)", () => {
    const m = receiptMessage(CHANNEL, 7);
    expect(m.length).toBe(44);
    expect(hex(m.subarray(0, 4))).toBe("484b5231");
    expect(hex(m.subarray(36))).toBe("0000000000000007");
    expect(hex(m)).toBe(IOU_7_MESSAGE);
  });

  it("encodes large counts big-endian", () => {
    expect(hex(receiptMessage(CHANNEL, 0x0102030405n).subarray(36))).toBe("0000000102030405");
  });

  it("rejects negative, non-integer and > u64 counts", () => {
    expect(() => receiptMessage(CHANNEL, -1)).toThrow();
    expect(() => receiptMessage(CHANNEL, 1.5)).toThrow();
    expect(() => receiptMessage(CHANNEL, 2n ** 64n)).toThrow();
  });

  it("rejects a channel id that isn't 32 bytes", () => {
    expect(() => receiptMessage("00".repeat(31), 1)).toThrow();
    expect(() => receiptMessage("zz".repeat(32), 1)).toThrow();
  });
});

describe("IOU keys and signatures", () => {
  it("golden vector: fixed key signs channel 00..01 / 7 to the bytes Aiken verifies", () => {
    expect(signReceipt(GOLDEN_SK, CHANNEL, 7)).toBe(SIG_7);
    expect(verifyReceipt(GOLDEN_PK, CHANNEL, 7, SIG_7)).toBe(true);
  });

  it("rejects another count, another channel, another key, and junk", () => {
    expect(verifyReceipt(GOLDEN_PK, CHANNEL, 8, SIG_7)).toBe(false);
    expect(verifyReceipt(GOLDEN_PK, "00".repeat(31) + "02", 7, SIG_7)).toBe(false);
    const other = newReceiptKey();
    expect(verifyReceipt(other.publicKey, CHANNEL, 7, SIG_7)).toBe(false);
    expect(verifyReceipt(GOLDEN_PK, CHANNEL, 7, "00".repeat(64))).toBe(false);
    expect(verifyReceipt(GOLDEN_PK, CHANNEL, 7, "abc")).toBe(false);
    expect(verifyReceipt("00", CHANNEL, 7, SIG_7)).toBe(false);
  });

  it("newReceiptKey makes a fresh 32-byte key pair that round-trips", () => {
    const a = newReceiptKey();
    const b = newReceiptKey();
    expect(a.secretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.secretKey).not.toBe(b.secretKey);
    const sig = signReceipt(a.secretKey, CHANNEL, 3);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyReceipt(a.publicKey, CHANNEL, 3, sig)).toBe(true);
  });
});

describe("parseIouHeader", () => {
  it("parses <int>.<128 hex>", () => {
    expect(parseIouHeader(`7.${SIG_7}`)).toEqual({ accepted: 7, signature: SIG_7 });
    expect(parseIouHeader(`0.${SIG_7}`)).toEqual({ accepted: 0, signature: SIG_7 });
    expect(parseIouHeader(`7.${SIG_7.toUpperCase()}`)).toEqual({ accepted: 7, signature: SIG_7 });
  });

  it.each([
    ["-1." + SIG_7],
    ["1." + SIG_7.slice(2)],
    ["1e3." + SIG_7],
    ["01." + SIG_7],
    ["1.5." + SIG_7],
    [" 1." + SIG_7],
    ["1." + SIG_7 + "00"],
    ["1." + "zz".repeat(64)],
    ["99999999999999999999." + SIG_7],
    [""],
    ["7"],
  ])("rejects %s", (v) => {
    expect(parseIouHeader(v)).toBeNull();
  });
});
