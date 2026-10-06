// Escrow channel routes. The status page is public: it holds nothing secret, and showing the latest IOU
// lets anyone check what the seller can claim on-chain.
import { Router } from "express";
import { sha256Hex } from "@hirakumi/core";
import { getChannel, getChannelByToken, recordIou, requestClose, type ChannelRow } from "@hirakumi/db";
import { PACK_ESCROW } from "@hirakumi/escrow";
import type { GatewayConfig } from "./config";
import type { AppDeps } from "./deps";
import { parseBearer } from "./http";
import { IOU_HEADER, checkIou, latestIou } from "./ious";

const txUrl = (h: string | null) => (h ? `https://preprod.cardanoscan.io/transaction/${h}` : null);

export function channelView(cfg: Pick<GatewayConfig, "publicBaseUrl">, ch: ChannelRow) {
  return {
    channelId: ch.channel_id,
    apiId: ch.api_id,
    packId: ch.pack_id,
    status: ch.status,
    refusedReason: ch.refused_reason,
    escrowAddress: PACK_ESCROW.address,
    maxCalls: ch.max_calls,
    pricePerCall: ch.price_per_call_micros,
    feeBps: ch.fee_bps,
    unsignedAllowance: ch.unsigned_allowance,
    contestPeriodMs: Number(ch.contest_period_ms),
    passesServed: ch.passes_served,
    iou: latestIou(ch),
    onchain: {
      accepted: ch.onchain_accepted,
      contestEnd: ch.contest_end_ms ? new Date(Number(ch.contest_end_ms)).toISOString() : null,
      utxo: ch.utxo_tx_hash ? `${ch.utxo_tx_hash}#${ch.utxo_output_index}` : null,
    },
    payouts: ch.settle_tx_hash
      ? { seller: ch.seller_paid_micros, fee: ch.fee_paid_micros, buyerRefund: ch.buyer_refund_micros }
      : null,
    txs: {
      lock: txUrl(ch.lock_tx_hash),
      close: txUrl(ch.close_tx_hash),
      raises: ch.raise_tx_hashes.map(txUrl),
      settle: txUrl(ch.settle_tx_hash),
    },
    datum: ch.datum_cbor,
    url: `${cfg.publicBaseUrl}/a/${ch.api_id}/channels/${ch.channel_id}`,
  };
}

export function channelsRouter(d: AppDeps): Router {
  const r = Router();

  r.get("/a/:apiId/channels/:channelId", async (req, res, next) => {
    try {
      const ch = await getChannel(d.sql, req.params.channelId.toLowerCase());
      if (!ch || ch.api_id !== req.params.apiId) { res.status(404).json({ error: "channel_not_found" }); return; }
      res.set("cache-control", "no-store").json(channelView(d.config, ch));
    } catch (e) { next(e); }
  });

  /** The buyer is done: the ChannelWatcher closes with the latest IOU. An IOU sent along is recorded first. */
  r.post("/a/:apiId/channels/:channelId/close", async (req, res, next) => {
    try {
      const bearer = parseBearer(req.header("authorization"));
      if (!bearer) { res.status(401).json({ error: "token_required" }); return; }
      const ch = await getChannelByToken(d.sql, req.params.apiId, sha256Hex(bearer));
      if (!ch || ch.channel_id !== req.params.channelId.toLowerCase()) { res.status(403).json({ error: "not_your_channel" }); return; }
      const iou = checkIou(ch, req.header(IOU_HEADER));
      if (!iou.ok) { res.status(iou.status).json(iou.body); return; }
      if (iou.iou) await recordIou(d.sql, ch.channel_id, iou.iou.accepted, iou.iou.signature);
      if (ch.status === "pending" || ch.status === "refused") { res.status(409).json({ error: "channel_not_locked", status: ch.status }); return; }
      const status = await requestClose(d.sql, ch.channel_id);
      const fresh = await getChannel(d.sql, ch.channel_id);
      res.status(202).json({ status, ...(fresh ? { channel: channelView(d.config, fresh) } : {}) });
    } catch (e) { next(e); }
  });

  return r;
}
