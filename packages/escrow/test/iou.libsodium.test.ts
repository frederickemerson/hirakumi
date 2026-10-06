// Cross-checks verifyReceipt against libsodium's crypto_sign_verify_detached,
// the cofactorless check behind cardano-node's verify_ed25519_signature.
// libsodium-wrappers-sumo is already in the pnpm store (via @cardano-sdk/crypto);
// it is loaded by path so this package needs no extra dependency.
import { randomBytes, randomInt } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { isValidReceiptKey, newReceiptKey, receiptMessage, signReceipt, verifyReceipt } from "../src/index.js";
import { L, TORSION, addTorsion, hex, le, leBytes, mixedKeySignature, mixedOrderSignature, torsionPoints, unhex } from "./ed25519.helpers.js";

type Sodium = {
  ready: Promise<void>;
  crypto_sign_verify_detached(sig: Uint8Array, msg: Uint8Array, pk: Uint8Array): boolean;
};
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sodium = createRequire(
  resolve(repo, "node_modules/.pnpm/libsodium-wrappers-sumo@0.7.10/node_modules/libsodium-wrappers-sumo/package.json"),
)("libsodium-wrappers-sumo") as Sodium;

const CH = "00".repeat(31) + "2a";

function sodiumVerify(pk: string, accepted: number, sig: string): boolean {
  try {
    return sodium.crypto_sign_verify_detached(unhex(sig), receiptMessage(CH, accepted), unhex(pk));
  } catch {
    return false;
  }
}

type Case = { name: string; pk: string; accepted: number; sig: string };

function flip(h: string): string {
  const b = unhex(h);
  const i = randomInt(b.length);
  b[i] = b[i]! ^ (1 << randomInt(8));
  return hex(b);
}

function cases(): Case[] {
  const out: Case[] = [];
  const small = torsionPoints();
  for (let i = 0; i < 300; i++) {
    const k = newReceiptKey();
    const n = randomInt(1000);
    const sig = signReceipt(k.secretKey, CH, n);
    const t = small[1 + (i % 7)]!;
    switch (i % 10) {
      case 0:
      case 1:
        out.push({ name: "honest", pk: k.publicKey, accepted: n, sig });
        break;
      case 2:
        out.push({ name: "bit-flipped sig", pk: k.publicKey, accepted: n, sig: flip(sig) });
        break;
      case 3:
        out.push({ name: "R+T", pk: k.publicKey, accepted: n, sig: mixedOrderSignature(k.secretKey, receiptMessage(CH, n), t) });
        break;
      case 4: {
        const m = mixedKeySignature(k.secretKey, receiptMessage(CH, n), t);
        out.push({ name: "A+T (libsodium-valid)", pk: m.pk, accepted: n, sig: m.sig });
        break;
      }
      case 5:
        out.push({ name: "A+T, honest sig", pk: addTorsion(k.publicKey, t), accepted: n, sig });
        break;
      case 6:
        out.push({ name: "S+L", pk: k.publicKey, accepted: n, sig: sig.slice(0, 64) + hex(leBytes(le(unhex(sig.slice(64))) + L)) });
        break;
      case 7:
        out.push({ name: "small-order key, R=small, S=0", pk: small[i % 8]!, accepted: n, sig: small[(i >> 3) % 8]! + "00".repeat(32) });
        break;
      case 8:
        out.push({ name: "honest key, small-order R", pk: k.publicKey, accepted: n, sig: small[i % 8]! + hex(randomBytes(31)) + "00" });
        break;
      default:
        out.push({ name: "bit-flipped key", pk: flip(k.publicKey), accepted: n, sig });
    }
  }
  // Fixed hostile vectors.
  out.push({ name: "identity key forgery", pk: "01" + "00".repeat(31), accepted: 1, sig: "01" + "00".repeat(63) });
  out.push({ name: "TORSION key", pk: TORSION, accepted: 1, sig: TORSION + "00".repeat(32) });
  return out;
}

describe("verifyReceipt agrees with libsodium (cardano-node)", () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  it("sanity: libsodium accepts honest IOUs and rejects the identity-key forgery", () => {
    const k = newReceiptKey();
    expect(sodiumVerify(k.publicKey, 3, signReceipt(k.secretKey, CH, 3))).toBe(true);
    expect(sodiumVerify("01" + "00".repeat(31), 1, "01" + "00".repeat(63))).toBe(false);
    // libsodium accepts a mixed-order key; we reject it (stricter, never looser).
    const m = mixedKeySignature(k.secretKey, receiptMessage(CH, 2));
    expect(sodiumVerify(m.pk, 2, m.sig)).toBe(true);
    expect(verifyReceipt(m.pk, CH, 2, m.sig)).toBe(false);
  });

  it("verifyReceipt ⇒ libsodium; equal whenever the key is a valid receipt key", () => {
    const all = cases();
    let honestOk = 0;
    for (const c of all) {
      const ours = verifyReceipt(c.pk, CH, c.accepted, c.sig);
      const theirs = sodiumVerify(c.pk, c.accepted, c.sig);
      if (ours) expect(theirs, `${c.name}: we accept what libsodium rejects`).toBe(true);
      if (isValidReceiptKey(c.pk)) expect(ours, `${c.name}: disagrees with libsodium`).toBe(theirs);
      if (c.name === "honest" && ours) honestOk += 1;
    }
    expect(honestOk).toBe(60);
  });
});
