// Independent verifier: tries to make verifyReceipt / verifyCloseRequest / isValidReceiptKey accept
// something libsodium (cardano-node's verify_ed25519_signature) rejects, or mix the HKR1/HKC1 domains.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { beforeAll, describe, expect, it } from "vitest";
import {
  closeRequestMessage, isValidReceiptKey, newReceiptKey, receiptMessage, signCloseRequest, signReceipt, verifyCloseRequest, verifyReceipt,
} from "../src/index.js";
import { L, TORSION, addTorsion, hex, le, leBytes, mixedOrderSignature, torsionPoints, unhex } from "./ed25519.helpers.js";

type Sodium = { ready: Promise<void>; crypto_sign_verify_detached(sig: Uint8Array, msg: Uint8Array, pk: Uint8Array): boolean };
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sodium = createRequire(
  resolve(repo, "node_modules/.pnpm/libsodium-wrappers-sumo@0.7.10/node_modules/libsodium-wrappers-sumo/package.json"),
)("libsodium-wrappers-sumo") as Sodium;

const P = 2n ** 255n - 19n;
const D = (-121665n * inv(121666n)) % P;
function mod(a: bigint) { const r = a % P; return r < 0n ? r + P : r; }
function pow(b: bigint, e: bigint) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; } return r; }
function inv(a: bigint) { return pow(mod(a), P - 2n); }
/** x for y on the curve (any root), or null. */
function xOf(y: bigint): bigint | null {
  const u = mod(y * y - 1n), v = mod(mod(D) * y * y + 1n);
  const x2 = mod(u * inv(v));
  if (x2 === 0n) return 0n;
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x) !== x2) x = mod(x * pow(2n, (P - 1n) / 4n));
  return mod(x * x) === x2 ? x : null;
}
function enc(y: bigint, sign: number): string {
  const b = leBytes(y);
  b[31] = (b[31]! & 0x7f) | (sign << 7);
  return hex(b);
}

const sodiumVerify = (pk: string, msg: Uint8Array, sig: string) => {
  try { return sodium.crypto_sign_verify_detached(unhex(sig), msg, unhex(pk)); } catch { return false; }
};
const CH = "ab".repeat(32);
const CH2 = "cd".repeat(32);

describe("verify: strict ed25519 vs libsodium", () => {
  beforeAll(async () => { await sodium.ready; });

  it("non-canonical encodings (y ≥ p, x=0 with sign bit) are never valid keys and never verify", () => {
    // Every encodable y in [p, 2^255) and the 19 small y values, both sign bits.
    const encs: string[] = [];
    for (let y0 = 0n; y0 < 19n; y0++) {
      for (const s of [0, 1]) {
        encs.push(enc(y0 + P, s));
        encs.push(enc(y0, s));
      }
    }
    const k = newReceiptKey();
    const honest = signReceipt(k.secretKey, CH, 3);
    for (const e of encs) {
      const y = le(unhex(e)) & ((1n << 255n) - 1n);
      const nonCanonical = y >= P;
      if (nonCanonical) expect(isValidReceiptKey(e), `non-canonical key ${e}`).toBe(false);
      // As a key, and as R, the verdict must imply libsodium's.
      const msg = receiptMessage(CH, 3);
      for (const sig of [e + honest.slice(64), e + "00".repeat(32), honest.slice(0, 64) + "00".repeat(32)]) {
        if (verifyReceipt(e, CH, 3, sig)) expect(sodiumVerify(e, msg, sig), `key ${e}`).toBe(true);
        if (verifyReceipt(k.publicKey, CH, 3, e + sig.slice(64))) expect(sodiumVerify(k.publicKey, msg, e + sig.slice(64))).toBe(true);
      }
    }
  });

  it("a prime-order point with a small y: canonical encoding is a valid key, its y+p alias is not", () => {
    // Find y < 19 on the curve whose point is torsion-free (if any) and check its alias.
    let checked = 0;
    for (let y0 = 2n; y0 < 19n; y0++) {
      const x = xOf(y0);
      if (x === null) continue;
      const canon = enc(y0, Number(x & 1n));
      let pt;
      try { pt = ed25519.Point.fromHex(canon); } catch { continue; }
      const alias = enc(y0 + P, Number(x & 1n));
      expect(isValidReceiptKey(alias), `alias of y=${y0}`).toBe(false);
      if (pt.isTorsionFree() && !pt.isSmallOrder()) expect(isValidReceiptKey(canon)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("S at and around L, and S with the top bits set, never verify where libsodium rejects", () => {
    const k = newReceiptKey();
    for (let i = 0; i < 40; i++) {
      const n = randomInt(1, 1_000_000);
      const sig = signReceipt(k.secretKey, CH, n);
      const s = le(unhex(sig.slice(64)));
      const msg = receiptMessage(CH, n);
      for (const s2 of [s + L, s + 2n * L, s + 4n * L, L, L - 1n, L + 1n, 2n ** 256n - 1n, s | (7n << 253n)]) {
        if (s2 >= 2n ** 256n) continue;
        const forged = sig.slice(0, 64) + hex(leBytes(s2));
        const ours = verifyReceipt(k.publicKey, CH, n, forged);
        if (ours) expect(sodiumVerify(k.publicKey, msg, forged)).toBe(true);
        if (s2 >= L) expect(ours).toBe(false);
      }
    }
  });

  it("differential fuzz: ours ⇒ libsodium, and ours == libsodium for every key newReceiptKey makes", { timeout: 120_000 }, () => {
    const small = torsionPoints();
    let agree = 0;
    for (let i = 0; i < 400; i++) {
      const k = newReceiptKey();
      expect(isValidReceiptKey(k.publicKey)).toBe(true);
      const n = randomInt(0, 2 ** 31);
      const msg = receiptMessage(CH, n);
      const sig = signReceipt(k.secretKey, CH, n);
      const t = small[1 + (i % 7)]!;
      const variants: [string, string][] = [
        [k.publicKey, sig],
        [k.publicKey, mixedOrderSignature(k.secretKey, msg, t)],
        [k.publicKey, addTorsion(sig.slice(0, 64), t) + sig.slice(64)],
        [addTorsion(k.publicKey, t), sig],
        [k.publicKey, hex(randomBytes(64))],
        [hex(randomBytes(32)), sig],
        [k.publicKey, sig.slice(0, 64) + hex(leBytes((le(unhex(sig.slice(64))) + L) % 2n ** 256n))],
        // R negated (sign bit flipped): a different point, must fail on both sides.
        [k.publicKey, sig.slice(0, 62) + (parseInt(sig.slice(62, 64), 16) ^ 0x80).toString(16).padStart(2, "0") + sig.slice(64)],
      ];
      for (const [pk, s] of variants) {
        const ours = verifyReceipt(pk, CH, n, s);
        const theirs = sodiumVerify(pk, msg, s);
        if (ours) expect(theirs, `ours accepts, libsodium rejects: pk=${pk} sig=${s}`).toBe(true);
        if (isValidReceiptKey(pk)) expect(ours, `liveness: pk=${pk}`).toBe(theirs);
        agree++;
      }
    }
    expect(agree).toBe(3200);
  });

  it("every newReceiptKey signature (IOU and close request) verifies under libsodium", () => {
    for (let i = 0; i < 200; i++) {
      const k = newReceiptKey();
      const n = randomInt(0, 2 ** 47);
      expect(sodiumVerify(k.publicKey, receiptMessage(CH, n), signReceipt(k.secretKey, CH, n))).toBe(true);
      expect(sodiumVerify(k.publicKey, closeRequestMessage(CH), signCloseRequest(k.secretKey, CH))).toBe(true);
    }
  });

  it("small-order and mixed-order keys are rejected as receipt keys (all 8 torsion points, with and without a prime part)", () => {
    const k = newReceiptKey();
    for (const t of torsionPoints()) {
      expect(isValidReceiptKey(t)).toBe(false);
      if (t !== torsionPoints()[0]) expect(isValidReceiptKey(addTorsion(k.publicKey, t))).toBe(false);
    }
    expect(isValidReceiptKey(TORSION)).toBe(false);
    expect(isValidReceiptKey("00".repeat(32))).toBe(false);
    expect(isValidReceiptKey("ff".repeat(32))).toBe(false);
    expect(isValidReceiptKey(k.publicKey.toUpperCase())).toBe(true); // hex case is not a key property
  });
});

describe("verify: HKR1 / HKC1 domain separation and channel binding", () => {
  it("a close request never verifies as an IOU (any count) and an IOU never verifies as a close request", () => {
    const k = newReceiptKey();
    const close = signCloseRequest(k.secretKey, CH);
    for (const n of [0, 1, 2, 7, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      expect(verifyReceipt(k.publicKey, CH, n, close)).toBe(false);
      expect(verifyCloseRequest(k.publicKey, CH, signReceipt(k.secretKey, CH, n))).toBe(false);
    }
    // The 36-byte close message is not a prefix-collision of any 44-byte IOU message.
    const cm = closeRequestMessage(CH);
    expect(cm.length).toBe(36);
    expect(Buffer.from(cm.subarray(0, 4)).toString()).toBe("HKC1");
    expect(Buffer.from(receiptMessage(CH, 0).subarray(0, 4)).toString()).toBe("HKR1");
  });

  it("a close request for one channel does not close another (same key, other channel)", () => {
    const k = newReceiptKey();
    expect(verifyCloseRequest(k.publicKey, CH2, signCloseRequest(k.secretKey, CH))).toBe(false);
    expect(verifyCloseRequest(newReceiptKey().publicKey, CH, signCloseRequest(k.secretKey, CH))).toBe(false);
    expect(verifyCloseRequest(k.publicKey, CH, signCloseRequest(k.secretKey, CH))).toBe(true);
  });

  it("a close request is checked as strictly as an IOU (torsion-mauled R rejected)", () => {
    const k = newReceiptKey();
    const msg = closeRequestMessage(CH);
    for (const t of torsionPoints().slice(1)) {
      const s = mixedOrderSignature(k.secretKey, msg, t);
      expect(verifyCloseRequest(k.publicKey, CH, s)).toBe(false);
    }
    // noble's own (cofactored) verify would accept these: proof that the strict path is the one used.
    const s = mixedOrderSignature(k.secretKey, msg, TORSION);
    expect(ed25519.verify(unhex(s), msg, unhex(k.publicKey))).toBe(true);
  });

  it("sanity: SHA-512 challenge is over raw bytes (a key with upper-case hex still verifies the same)", () => {
    const k = newReceiptKey();
    const sig = signReceipt(k.secretKey, CH, 5);
    expect(verifyReceipt(k.publicKey.toUpperCase(), CH.toUpperCase(), 5, sig.toUpperCase())).toBe(true);
    void createHash;
  });
});
