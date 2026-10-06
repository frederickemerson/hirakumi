import { createHash } from "node:crypto";
import { parseAddress } from "./address.js";
import { bytesOf } from "./hex.js";

function field(b: Uint8Array): Buffer {
  if (b.length > 0xffff) throw new Error("field too long");
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
}

/**
 * channel_id = sha256("hk-channel" ‖ len16‖apiId ‖ len16‖packId ‖ receiptKey(32)
 *                     ‖ len16‖refundAddressBytes ‖ quoteNonce(16))
 * Variable-length fields carry a 2-byte big-endian length so ids can't be
 * shifted from one field into the next. Returns 64 hex chars.
 */
export function deriveChannelId(p: {
  apiId: string;
  packId: string;
  receiptKey: string;
  refundAddress: string;
  quoteNonce: string;
}): string {
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("hk-channel", "ascii"),
        field(Buffer.from(p.apiId, "utf8")),
        field(Buffer.from(p.packId, "utf8")),
        bytesOf("receiptKey", p.receiptKey, 32),
        field(parseAddress("refundAddress", p.refundAddress).bytes),
        bytesOf("quoteNonce", p.quoteNonce, 16),
      ]),
    )
    .digest("hex");
}
