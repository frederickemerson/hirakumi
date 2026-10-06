// Hostile ed25519 inputs for the strict-verification tests.
import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";

export const L = 2n ** 252n + 27742317777372353535851937790883648493n;
/** A point of order 8. */
export const TORSION = "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a";

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
export const le = (b: Uint8Array) => {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) + BigInt(b[i]!);
  return n;
};

export function leBytes(n: bigint): Uint8Array {
  const o = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    o[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return o;
}

/** T·k for k = 0..7: every small-order point, canonically encoded. */
export function torsionPoints(): string[] {
  const t = ed25519.Point.fromHex(TORSION);
  const out: string[] = [];
  let acc = ed25519.Point.ZERO;
  for (let k = 0; k < 8; k++) {
    out.push(hex(acc.toBytes()));
    acc = acc.add(t);
  }
  return out;
}

/** `point + T` (hex in, hex out). */
export function addTorsion(point: string, t: string): string {
  return hex(ed25519.Point.fromHex(point).add(ed25519.Point.fromHex(t)).toBytes());
}

/** An honest key's signature over `msg`, but R gets an 8-torsion component: cofactored verify passes, cofactorless fails. */
export function mixedOrderSignature(sk: string, msg: Uint8Array, torsion = TORSION): string {
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(unhex(sk));
  const r = le(randomBytes(64)) % L;
  const R = ed25519.Point.BASE.multiply(r).add(ed25519.Point.fromHex(torsion)).toBytes();
  const k = le(createHash("sha512").update(R).update(pointBytes).update(msg).digest()) % L;
  return hex(R) + hex(leBytes((r + k * scalar) % L));
}

/**
 * A mixed-order key A' = aB + T and a signature that libsodium accepts for it:
 * R = rB, k = H(R ‖ A' ‖ M), S = r + k·a, so [S]B = R + [k]A' − [k]T, which is
 * R + [k]A' exactly when k ≡ 0 (mod 8). Retries r until it is.
 */
export function mixedKeySignature(sk: string, msg: Uint8Array, torsion = TORSION): { pk: string; sig: string } {
  const { scalar, point } = ed25519.utils.getExtendedPublicKey(unhex(sk));
  const pk = point.add(ed25519.Point.fromHex(torsion)).toBytes();
  for (;;) {
    const r = le(randomBytes(64)) % L;
    const R = ed25519.Point.BASE.multiply(r).toBytes();
    const k = le(createHash("sha512").update(R).update(pk).update(msg).digest()) % L;
    if (k % 8n !== 0n) continue;
    return { pk: hex(pk), sig: hex(R) + hex(leBytes((r + k * scalar) % L)) };
  }
}
