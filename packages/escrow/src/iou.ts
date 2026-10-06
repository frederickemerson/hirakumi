// IOUs: the buyer's signed, cumulative "I accept N calls" for one pack.
// Byte layout and signature scheme match contracts/pack-escrow/lib/hirakumi/iou.ak.
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
// Extensionless, like @hirakumi/core: the web bundles this file from source (apps/web/lib/try-escrow.ts).
import { bytesOf, hexOf, toHex } from "./hex";

const PREFIX = Uint8Array.from([0x48, 0x4b, 0x52, 0x31]); // "HKR1"
const CLOSE_PREFIX = Uint8Array.from([0x48, 0x4b, 0x43, 0x31]); // "HKC1"
const U64_MAX = 2n ** 64n - 1n;

function count(accepted: number | bigint): bigint {
  if (typeof accepted === "number" && !Number.isSafeInteger(accepted)) throw new Error("accepted must be an integer");
  const n = BigInt(accepted);
  if (n < 0n || n > U64_MAX) throw new Error("accepted must fit an unsigned 64-bit integer");
  return n;
}

/** 44 bytes: "HKR1" ‖ channel_id(32) ‖ accepted as 8-byte unsigned big-endian. Sign these bytes, never a hash. */
export function receiptMessage(channelId: string, accepted: number | bigint): Uint8Array {
  const msg = new Uint8Array(44);
  msg.set(PREFIX, 0);
  msg.set(bytesOf("channelId", channelId, 32), 4);
  new DataView(msg.buffer).setBigUint64(36, count(accepted), false);
  return msg;
}

/** A fresh ed25519 key pair for one pack's IOUs. `publicKey` goes in the datum as `receiptKey`. */
export function newReceiptKey(): { secretKey: string; publicKey: string } {
  const sk = ed25519.utils.randomPrivateKey();
  return { secretKey: toHex(sk), publicKey: toHex(ed25519.getPublicKey(sk)) };
}

/** Signs an IOU. Returns the raw 64-byte ed25519 signature as hex. */
export function signReceipt(secretKey: string, channelId: string, accepted: number | bigint): string {
  return toHex(ed25519.sign(receiptMessage(channelId, accepted), bytesOf("secretKey", secretKey, 32)));
}

// Strict, cofactorless ed25519 verification with libsodium 1.0.18 semantics
// (what cardano-node's verify_ed25519_signature runs). noble's ed25519.verify
// multiplies by the cofactor even with zip215:false, so it accepts signatures
// the chain rejects (small-order keys, R with a torsion component).
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const P = ed25519.Point;

function le(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

/** Decodes a public key the way libsodium accepts it, minus mixed-order keys (stricter, never looser). Throws when unusable. */
function receiptPoint(pk: Uint8Array) {
  const A = P.fromBytes(pk, false); // rejects y >= p and x=0 with the sign bit set
  if (A.isSmallOrder() || !A.isTorsionFree()) throw new Error("receipt key is small or mixed order");
  return A;
}

function strictVerify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  const s = le(sig.subarray(32));
  if (s >= L) return false; // canonical S
  const A = receiptPoint(pk);
  const R = P.fromBytes(sig.subarray(0, 32), false);
  if (R.isSmallOrder()) return false; // libsodium rejects small-order R
  // k = SHA-512(R ‖ A ‖ M) over the RAW bytes, like libsodium.
  const k = le(createHash("sha512").update(sig.subarray(0, 32)).update(pk).update(msg).digest()) % L;
  return P.BASE.multiplyUnsafe(s).equals(R.add(A.multiplyUnsafe(k))); // cofactorless: [S]B == R + [k]A
}

/**
 * Same check the validator runs with `verify_ed25519_signature` on cardano-node
 * (libsodium, cofactorless), and stricter on mixed-order keys. Never throws.
 */
export function verifyReceipt(publicKey: string, channelId: string, accepted: number | bigint, signature: string): boolean {
  try {
    return strictVerify(bytesOf("publicKey", publicKey, 32), receiptMessage(channelId, accepted), bytesOf("signature", signature, 64));
  } catch {
    return false;
  }
}

/**
 * True when `publicKey` is 32-byte hex encoding a canonical point that is not
 * small order and is torsion-free: a key some on-chain IOU can be valid for.
 * Keys from `newReceiptKey()` always pass. Never throws.
 */
export function isValidReceiptKey(publicKey: string): boolean {
  try {
    receiptPoint(bytesOf("publicKey", publicKey, 32));
    return true;
  } catch {
    return false;
  }
}

/**
 * 36 bytes: "HKC1" ‖ channel_id(32). Signed by the receipt key to ask the
 * gateway to close a channel without a bearer token. The validator only
 * verifies 44-byte "HKR1" messages, so this can never be used on-chain.
 */
export function closeRequestMessage(channelId: string): Uint8Array {
  const msg = new Uint8Array(36);
  msg.set(CLOSE_PREFIX, 0);
  msg.set(bytesOf("channelId", channelId, 32), 4);
  return msg;
}

/** Signs a close request (header `x-hirakumi-close-auth`). Returns 128 hex. */
export function signCloseRequest(secretKey: string, channelId: string): string {
  return toHex(ed25519.sign(closeRequestMessage(channelId), bytesOf("secretKey", secretKey, 32)));
}

/** Strict verification of a close request, like `verifyReceipt`. Never throws. */
export function verifyCloseRequest(publicKey: string, channelId: string, signature: string): boolean {
  try {
    return strictVerify(bytesOf("publicKey", publicKey, 32), closeRequestMessage(channelId), bytesOf("signature", signature, 64));
  } catch {
    return false;
  }
}

const HEADER = /^(0|[1-9][0-9]{0,15})\.([0-9a-fA-F]{128})$/;

/** Parses an IOU header `"<accepted>.<128 hex signature>"`. Null when malformed. */
export function parseIouHeader(v: string): { accepted: number; signature: string } | null {
  const m = typeof v === "string" ? HEADER.exec(v) : null;
  if (!m) return null;
  const accepted = Number(m[1]);
  if (!Number.isSafeInteger(accepted)) return null;
  return { accepted, signature: hexOf("signature", m[2]!, 64) };
}
