import { Router } from "express";
import { inputHash, newId, outputHash, sha256Hex } from "@hirakumi/core";
import {
  finishChannelCall, gateChannelCall, getChannelByToken, getReceipts, insertCall, markExhaustedIfEmpty, releaseCredit, reserveCredit,
  type Reservation,
} from "@hirakumi/db";
import { channelView } from "./channels";
import { IOU_HEADER, SIGN_NEXT_HEADER, checkIou } from "./ious";
import type { AppDeps } from "./deps";
import { creditsRequiredBody, downBody, parseBearer } from "./http";
import { runOperation, type OperationOutcome } from "./upstream";

export function creditsRouter(d: AppDeps): Router {
  const r = Router();
  /**
   * The buyer's receipts: what each credit call cost and why, against the rule hash published before purchase.
   * Credits are counted off-chain, so this is how a buyer audits the gateway instead of trusting it blindly.
   */
  r.get("/a/:apiId/receipts", async (req, res, next) => {
    try {
      const bearer = parseBearer(req.header("authorization"));
      if (!bearer) { res.status(401).json({ error: "token_required", message: "Send your pack token as Authorization: Bearer <token>." }); return; }
      const found = await getReceipts(d.sql, req.params.apiId, sha256Hex(bearer));
      if (!found) { res.status(401).json({ error: "invalid_token" }); return; }
      const channel = await getChannelByToken(d.sql, req.params.apiId, sha256Hex(bearer));
      res.set("cache-control", "no-store").json({
        ...found,
        ...(channel ? { channel: channelView(d.config, channel) } : {}),
        verify:
          "charged is true only when the API answered and the answer passed the rule (ruleHash, see /r/<ruleHash>). " +
          "To check a paid answer, compute outputHash = sha256(token.id + ';' + body) as in MIP-004 over the exact body you received.",
      });
    } catch (e) { next(e); }
  });

  r.all("/a/:apiId/x/:opId", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded || loaded.api.state !== "live") { res.status(404).json({ error: "api_not_found" }); return; }
      const op = loaded.ops.get(req.params.opId);
      if (!op || !op.row.enabled) { res.status(404).json({ error: "operation_not_found" }); return; }
      if (req.method !== op.row.method.toUpperCase()) {
        res.status(405).set("allow", op.row.method.toUpperCase()).json({ error: "method_not_allowed" }); return;
      }
      const checked = op.validateInput(req.method === "GET" ? req.query : req.body);
      if (!checked.ok) { res.status(400).json({ error: "invalid_input", reasons: checked.reasons }); return; }
      const snap = d.health.get(loaded.api.id);
      if (snap?.health === "down") { res.status(503).json(downBody(d.config, snap)); return; }
      if (!op.rule || !op.ruleRow) { res.status(503).json({ error: "promise_not_published" }); return; }

      const authorization = req.header("authorization");
      const bearer = parseBearer(authorization);
      // A Bearer value that isn't a Hirakumi token is a client bug: say so instead of offering another pack.
      if (!bearer && /^\s*Bearer\s+\S/i.test(authorization ?? "")) { res.status(401).json({ error: "invalid_token" }); return; }
      if (!bearer) { res.status(402).json(creditsRequiredBody(d.config, loaded, op.ruleRow)); return; }
      // Escrow packs: the IOU gate (one DB transaction: row lock, allowance, credit, lease) replaces the plain reserve.
      const channel = await getChannelByToken(d.sql, loaded.api.id, sha256Hex(bearer));
      const callId = newId("call");
      let reservation: Reservation;
      if (channel) {
        const iou = checkIou(channel, req.header(IOU_HEADER));
        if (!iou.ok) { res.status(iou.status).json({ ...iou.body, channelId: channel.channel_id }); return; }
        const gate = await gateChannelCall(d.sql, {
          channelId: channel.channel_id, callId, leaseSeconds: d.config.packEscrow?.leaseSeconds ?? 30, verifiedIou: iou.iou,
        });
        if (!gate.ok && gate.reason === "iou_required") {
          res.status(402).set(SIGN_NEXT_HEADER, String(gate.channel!.passes_served)).json({
            error: "iou_required", channelId: channel.channel_id, signNext: gate.channel!.passes_served,
            iouAccepted: gate.channel!.iou_accepted, unsignedAllowance: gate.channel!.unsigned_allowance,
            message: `Sign an IOU for ${gate.channel!.passes_served} calls and send it as X-Hirakumi-IOU: <n>.<signature>.`,
          });
          return;
        }
        if (!gate.ok && gate.reason === "closing") {
          res.status(409).json({ error: "channel_closing", channelId: channel.channel_id, status: gate.channel!.status }); return;
        }
        reservation = gate.ok ? { ok: true, tokenId: gate.tokenId, remainingAfter: gate.remainingAfter } : { ok: false, reason: gate.reason as "not_found" | "pending" | "revoked" | "exhausted" };
      } else {
        reservation = await reserveCredit(d.sql, loaded.api.id, sha256Hex(bearer));
      }
      const finish = async (passed: boolean): Promise<number | null> =>
        channel ? finishChannelCall(d.sql, { channelId: channel.channel_id, callId, passed }) : null;
      if (!reservation.ok) {
        if (reservation.reason === "not_found" || reservation.reason === "revoked") {
          res.status(401).json({ error: "invalid_token" }); return;
        }
        // Contract v1.1 G4: a token whose pack payment hasn't settled yet is not usable.
        if (reservation.reason === "pending") { res.status(401).json({ error: "token_pending" }); return; }
        res.status(402).json({ ...creditsRequiredBody(d.config, loaded, op.ruleRow), error: "credits_required" });
        return;
      }

      const tokenId = reservation.tokenId;
      let outcome: OperationOutcome;
      try {
        outcome = await runOperation(loaded.api, op, checked.value, { timeoutMs: d.config.upstreamTimeoutMs });
        await insertCall(d.sql, {
          kind: "credit", creditTokenId: tokenId, apiId: loaded.api.id, opId: op.row.op_id, ruleId: op.ruleRow.id,
          execution: outcome.execution, verdict: outcome.verdict, reasons: outcome.reasons, latencyMs: outcome.latencyMs,
          inputHash: inputHash(tokenId, checked.value),
          outputHash: outcome.result ? outputHash(tokenId, outcome.result.body) : null,
        });
      } catch (e) {
        await releaseCredit(d.sql, tokenId);
        await finish(false);
        throw e;
      }

      if (outcome.execution === "upstream_ok" && outcome.verdict === "pass" && outcome.result) {
        if (reservation.remainingAfter === 0) await markExhaustedIfEmpty(d.sql, tokenId);
        const served = await finish(true);
        if (served !== null) res.set(SIGN_NEXT_HEADER, String(served));
        res.status(200)
          .set("x-credits-remaining", String(reservation.remainingAfter))
          .type(outcome.result.contentType ?? "application/json")
          .send(outcome.result.body);
        return;
      }

      await releaseCredit(d.sql, tokenId);
      await finish(false);
      res.set("x-credits-remaining", String(reservation.remainingAfter + 1));
      if (outcome.execution === "timeout") { res.status(504).json({ error: "upstream_timeout", reasons: outcome.reasons }); return; }
      if (outcome.execution === "upstream_ok") { res.status(422).json({ error: "promise_not_met", reasons: outcome.reasons }); return; }
      res.status(502).json({ error: "upstream_error", reasons: outcome.reasons });
    } catch (e) {
      next(e);
    }
  });
  return r;
}
