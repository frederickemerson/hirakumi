// IOUs on escrow-pack calls: the buyer's signed, cumulative "I accept N calls". The gateway only serves
// `unsigned_allowance` passes ahead of the latest IOU; the chain pays the seller only what an IOU proves.
import { parseIouHeader, receiptMessage, verifyReceipt } from "@hirakumi/escrow";
import type { ChannelRow } from "@hirakumi/db";

export const IOU_HEADER = "x-hirakumi-iou";
export const SIGN_NEXT_HEADER = "x-hirakumi-sign-next";

export type IouCheck =
  | { ok: true; iou?: { accepted: number; signature: string } }
  | { ok: false; status: 401; body: { error: "bad_iou" | "iou_ahead"; message: string } };

/**
 * Validates an `X-Hirakumi-IOU: <n>.<sig>` header against the channel. Absent → ok with no IOU.
 * A signature that doesn't verify for this channel's key and id is 401 bad_iou; a count above the passes
 * actually served is 401 iou_ahead (the buyer can't pre-sign calls it hasn't received).
 */
export function checkIou(ch: Pick<ChannelRow, "receipt_key" | "channel_id" | "passes_served">, header: string | undefined): IouCheck {
  if (header === undefined || header.trim() === "") return { ok: true };
  const parsed = parseIouHeader(header.trim());
  if (!parsed || !verifyReceipt(ch.receipt_key, ch.channel_id, parsed.accepted, parsed.signature)) {
    return { ok: false, status: 401, body: { error: "bad_iou", message: "The IOU signature does not verify for this channel's receipt key." } };
  }
  if (parsed.accepted > ch.passes_served) {
    return {
      ok: false, status: 401,
      body: { error: "iou_ahead", message: `This IOU accepts ${parsed.accepted} calls but only ${ch.passes_served} passing calls were served.` },
    };
  }
  return { ok: true, iou: parsed };
}

/** Everything a third party needs to check the latest IOU against the on-chain datum. */
export function latestIou(ch: Pick<ChannelRow, "receipt_key" | "channel_id" | "iou_accepted" | "iou_signature">) {
  return {
    accepted: ch.iou_accepted,
    signature: ch.iou_signature,
    receiptKey: ch.receipt_key,
    message: Buffer.from(receiptMessage(ch.channel_id, ch.iou_accepted)).toString("hex"),
    scheme: "ed25519 over \"HKR1\" ‖ channel_id(32) ‖ accepted (u64 big-endian)",
  };
}
