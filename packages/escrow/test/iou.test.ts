import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import {
  closeRequestMessage,
  isValidReceiptKey,
  newReceiptKey,
  parseIouHeader,
  receiptMessage,
  signCloseRequest,
  signReceipt,
  verifyCloseRequest,
  verifyReceipt,
} from "../src/index.js";
import { L, TORSION, addTorsion, hex, le, leBytes, mixedKeySignature, mixedOrderSignature, torsionPoints, unhex } from "./ed25519.helpers.js";
import { CHANNEL, GOLDEN_PK, GOLDEN_SK, IOU_7_MESSAGE, SIG_7 } from "./golden.js";

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

describe("strict (cofactorless) verification, like cardano-node", () => {
  it("the golden SIG_7 still verifies", () => {
    expect(verifyReceipt(GOLDEN_PK, CHANNEL, 7, SIG_7)).toBe(true);
  });

  it("rejects the identity key with R = identity, S = 0 (noble's cofactored verify accepts it)", () => {
    const pk = "01" + "00".repeat(31);
    const sig = "01" + "00".repeat(63);
    expect(ed25519.verify(unhex(sig), receiptMessage(CHANNEL, 5), unhex(pk))).toBe(true);
    expect(verifyReceipt(pk, CHANNEL, 5, sig)).toBe(false);
  });

  it("rejects an honest key's signature whose R has an 8-torsion component", () => {
    const k = newReceiptKey();
    const sig = mixedOrderSignature(k.secretKey, receiptMessage(CHANNEL, 3));
    expect(ed25519.verify(unhex(sig), receiptMessage(CHANNEL, 3), unhex(k.publicKey))).toBe(true);
    expect(verifyReceipt(k.publicKey, CHANNEL, 3, sig)).toBe(false);
  });

  it("rejects S + L (non-canonical S)", () => {
    const s = le(unhex(SIG_7.slice(64)));
    expect(verifyReceipt(GOLDEN_PK, CHANNEL, 7, SIG_7.slice(0, 64) + hex(leBytes(s + L)))).toBe(false);
  });

  it("rejects R or A encoded with y >= p", () => {
    // y = p + 3: a point only under non-canonical decoding.
    const nonCanonical = "f0" + "ff".repeat(30) + "7f";
    expect(verifyReceipt(GOLDEN_PK, CHANNEL, 7, nonCanonical + SIG_7.slice(64))).toBe(false);
    expect(verifyReceipt(nonCanonical, CHANNEL, 7, SIG_7)).toBe(false);
    expect(isValidReceiptKey(nonCanonical)).toBe(false);
    // y = p + 1: the identity, non-canonically encoded.
    expect(isValidReceiptKey("ee" + "ff".repeat(30) + "7f")).toBe(false);
  });

  it("isValidReceiptKey: false for the 8 torsion points and honestPk + T, true for fresh keys", () => {
    const pts = torsionPoints();
    expect(new Set(pts).size).toBe(8);
    for (const t of pts) expect(isValidReceiptKey(t)).toBe(false);
    const honest = newReceiptKey().publicKey;
    expect(isValidReceiptKey(honest)).toBe(true);
    expect(isValidReceiptKey(addTorsion(honest, TORSION))).toBe(false);
    expect(isValidReceiptKey(GOLDEN_PK)).toBe(true);
    for (let i = 0; i < 20; i++) expect(isValidReceiptKey(newReceiptKey().publicKey)).toBe(true);
  });

  it("rejects a mixed-order key even with a signature libsodium would accept (stricter is the safe side)", () => {
    const { pk, sig } = mixedKeySignature(newReceiptKey().secretKey, receiptMessage(CHANNEL, 4));
    expect(verifyReceipt(pk, CHANNEL, 4, sig)).toBe(false);
  });

  it("isValidReceiptKey rejects junk without throwing", () => {
    expect(isValidReceiptKey("")).toBe(false);
    expect(isValidReceiptKey("zz".repeat(32))).toBe(false);
    expect(isValidReceiptKey(GOLDEN_PK + "00")).toBe(false);
    expect(isValidReceiptKey(undefined as unknown as string)).toBe(false);
  });

  it("an independently computed RFC 8032 signature verifies (hash over raw R ‖ A ‖ M)", () => {
    const k = newReceiptKey();
    const msg = receiptMessage(CHANNEL, 9);
    const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(unhex(k.secretKey));
    const r = le(randomBytes(64)) % L;
    const R = ed25519.Point.BASE.multiply(r).toBytes();
    const kk = le(createHash("sha512").update(R).update(pointBytes).update(msg).digest()) % L;
    expect(verifyReceipt(k.publicKey, CHANNEL, 9, hex(R) + hex(leBytes((r + kk * scalar) % L)))).toBe(true);
  });
});

describe("close requests (x-hirakumi-close-auth)", () => {
  it("message is 36 bytes: HKC1 ‖ channel", () => {
    const m = closeRequestMessage(CHANNEL);
    expect(m.length).toBe(36);
    expect(hex(m)).toBe("484b4331" + CHANNEL);
    expect(() => closeRequestMessage("00".repeat(31))).toThrow();
  });

  it("sign / verify round trip", () => {
    const k = newReceiptKey();
    const sig = signCloseRequest(k.secretKey, CHANNEL);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyCloseRequest(k.publicKey, CHANNEL, sig)).toBe(true);
    expect(verifyCloseRequest(k.publicKey, CHANNEL, sig.toUpperCase())).toBe(true);
    expect(verifyCloseRequest(k.publicKey, "00".repeat(31) + "02", sig)).toBe(false);
    expect(verifyCloseRequest(newReceiptKey().publicKey, CHANNEL, sig)).toBe(false);
    expect(verifyCloseRequest(k.publicKey, CHANNEL, "abc")).toBe(false);
    expect(verifyCloseRequest("00", CHANNEL, sig)).toBe(false);
  });

  it("an HKR1 IOU signature is not a close request, and vice versa", () => {
    expect(verifyCloseRequest(GOLDEN_PK, CHANNEL, SIG_7)).toBe(false);
    const k = newReceiptKey();
    for (const n of [0, 1, 7]) {
      expect(verifyCloseRequest(k.publicKey, CHANNEL, signReceipt(k.secretKey, CHANNEL, n))).toBe(false);
      expect(verifyReceipt(k.publicKey, CHANNEL, n, signCloseRequest(k.secretKey, CHANNEL))).toBe(false);
    }
  });

  it("rejects the small-order forgery as a close request", () => {
    expect(verifyCloseRequest("01" + "00".repeat(31), CHANNEL, "01" + "00".repeat(63))).toBe(false);
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
