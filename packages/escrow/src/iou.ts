// IOUs: the buyer's signed, cumulative "I accept N calls" for one pack.
// Byte layout and signature scheme match contracts/pack-escrow/lib/hirakumi/iou.ak.
import { ed25519 } from "@noble/curves/ed25519";
import { bytesOf, hexOf, toHex } from "./hex.js";

const PREFIX = Uint8Array.from([0x48, 0x4b, 0x52, 0x31]); // "HKR1"
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

/** Same check the validator runs with `verify_ed25519_signature`. Never throws. */
export function verifyReceipt(publicKey: string, channelId: string, accepted: number | bigint, signature: string): boolean {
  try {
    return ed25519.verify(
      bytesOf("signature", signature, 64),
      receiptMessage(channelId, accepted),
      bytesOf("publicKey", publicKey, 32),
    );
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
