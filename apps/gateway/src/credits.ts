import { Router, type Request, type Response } from "express";
import { inputHash, newId, outputHash, sha256Hex } from "@hirakumi/core";
import {
  finishChannelCall, gateChannelCall, getChannelByToken, getReceipts, insertCall, markExhaustedIfEmpty, releaseCredit, reserveCredit,
  type Reservation,
} from "@hirakumi/db";
import { channelView } from "./channels";
import { IOU_HEADER, SIGN_NEXT_HEADER, checkIou } from "./ious";
import type { AppDeps } from "./deps";
import type { GatewayConfig } from "./config";
import type { LoadedApi, LoadedOp } from "./registry";
import { creditsRequiredBody, downBody, parseBearer, SELLER_BODY_HEADERS, sellingPausedBody } from "./http";
import { createFailureCounter, type FailureCounter } from "./limiter";
import { runOperation, type OperationOutcome } from "./upstream";

/**
 * Failed calls are free, so this caps how fast one token (or channel) can make them: enough to burn a seller's shared
 * upstream quota or force leak scans. Past it, calls are refused before any credit is reserved or upstream is called.
 */
export const FAILED_CALLS_LIMIT = { max: 20, windowMs: 60_000 };

/**
 * One failure counter per app, shared by every paid path (/a/:apiId/x/:opId and the front door), so a token can't
 * double its free failures by switching between the two addresses of the same API.
 */
const failureCounters = new WeakMap<AppDeps, FailureCounter>();
function failuresFor(d: AppDeps): FailureCounter {
  let counter = failureCounters.get(d);
  if (!counter) {
    counter = createFailureCounter(FAILED_CALLS_LIMIT.max, FAILED_CALLS_LIMIT.windowMs);
    failureCounters.set(d, counter);
  }
  return counter;
}

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
      await handlePaidCall(d, loaded, op, req.method === "GET" ? req.query : req.body, req, res, { via: "native" });
    } catch (e) {
      next(e);
    }
  });
  return r;
}

/** Where a paid call came in: Hirakumi's own URL (/a/:apiId/x/:opId) or the seller's hostname (frontDoor.ts). */
export type CallVia = "native" | "front_door";

/**
 * The front door's 402: the usual offer, plus a sentence for whoever was calling the seller's API directly, the
 * listing page and the native URL. Every URL is built from configuration, never from the request's Host.
 */
export function frontDoorOfferBody(
  cfg: Pick<GatewayConfig, "publicBaseUrl" | "webBaseUrl">, loaded: LoadedApi, op: LoadedOp, base: ReturnType<typeof creditsRequiredBody>,
) {
  const buyUrl = base.packs[0]?.buyUrl;
  const listingUrl = cfg.webBaseUrl ? `${cfg.webBaseUrl}/p/${loaded.api.id}` : null;
  return {
    ...base,
    message: `This API is only available through Hirakumi. ${buyUrl ? `Buy a pack of calls: ${buyUrl}` : "See how to buy calls at the listing page."}`,
    ...(listingUrl ? { listingUrl } : {}),
    gatewayUrl: `${cfg.publicBaseUrl}/a/${loaded.api.id}/x/${op.row.op_id}`,
  };
}

/**
 * One paid call, after routing chose the API and operation: input check, health, the 402 offer, the credit (or
 * escrow IOU), the upstream call, the promise check and the receipt. Shared by the native route and the front door.
 */
export async function handlePaidCall(
  d: AppDeps, loaded: LoadedApi, op: LoadedOp, rawInput: unknown, req: Request, res: Response, opts: { via: CallVia },
): Promise<void> {
  const checked = op.validateInput(rawInput);
  if (!checked.ok) { res.status(400).json({ error: "invalid_input", reasons: checked.reasons }); return; }
  const snap = d.health.get(loaded.api.id);
  if (snap?.health === "down") { res.status(503).json(downBody(d.config, snap)); return; }
  if (!op.rule || !op.ruleRow) { res.status(503).json({ error: "promise_not_published" }); return; }

  const authorization = req.header("authorization");
  const bearer = parseBearer(authorization);
  // A Bearer value that isn't a Hirakumi token is a client bug: say so instead of offering another pack. On the
  // front door it is usually the seller's old key, sent to the old address: the caller gets the offer instead.
  const foreignBearer = !bearer && /^\s*Bearer\s+\S/i.test(authorization ?? "");
  if (foreignBearer && opts.via === "native") { res.status(401).json({ error: "invalid_token" }); return; }
  const pausedBody = sellingPausedBody(loaded.api);
  const ruleRow = op.ruleRow;
  const offer = () => {
    const base = creditsRequiredBody(d.config, loaded, ruleRow);
    if (opts.via === "native") { res.status(402).json(base); return; }
    const body = frontDoorOfferBody(d.config, loaded, op, base);
    if (body.listingUrl) res.set("link", `<${body.listingUrl}>; rel="payment"`);
    res.status(402).set("cache-control", "no-store").json(body);
  };
  if (!bearer) {
    if (pausedBody) { res.status(503).json(pausedBody); return; }
    offer(); return;
  }
  // Escrow packs: the IOU gate (one DB transaction: row lock, allowance, credit, lease) replaces the plain reserve.
  const tokenHash = sha256Hex(bearer);
  const channel = await getChannelByToken(d.sql, loaded.api.id, tokenHash);
  // Keyed by the token's hash (or the channel), so a token already at the limit is refused before anything is
  // reserved. Calls running at once are counted once their credit is reserved (below), so a burst of calls with a
  // token that turns out invalid still gets 401s, not 429s.
  const failures = failuresFor(d);
  const failureKey = channel ? `channel:${channel.channel_id}` : `token:${tokenHash}`;
  const tooManyFailed = (retryAfter: number) => {
    res.status(429).set("retry-after", String(retryAfter)).json({
      error: "too_many_failed_calls",
      message: `Too many failed calls with this token in the last minute. Try again in ${retryAfter} seconds.`,
    });
  };
  const blocked = failures.blocked(failureKey);
  if (blocked) { tooManyFailed(blocked.retryAfter); return; }
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
    reservation = await reserveCredit(d.sql, loaded.api.id, tokenHash);
  }
  const finish = async (passed: boolean): Promise<number | null> =>
    channel ? finishChannelCall(d.sql, { channelId: channel.channel_id, callId, passed }) : null;
  if (!reservation.ok) {
    if (reservation.reason === "not_found" || reservation.reason === "revoked") {
      res.status(401).json({ error: "invalid_token" }); return;
    }
    // Contract v1.1 G4: a token whose pack payment hasn't settled yet is not usable.
    if (reservation.reason === "pending") { res.status(401).json({ error: "token_pending" }); return; }
    if (pausedBody) { res.status(503).json(pausedBody); return; }
    offer();
    return;
  }

  const tokenId = reservation.tokenId;
  // Calls still running count toward the limit too: past it this waits for one to end, and is refused (with the
  // credit given back) if that leaves the token at the limit. pending.end() records whether this call failed.
  const pending = await failures.begin(failureKey);
  if ("retryAfter" in pending) {
    await releaseCredit(d.sql, tokenId);
    await finish(false);
    tooManyFailed(pending.retryAfter);
    return;
  }
  let outcome: OperationOutcome;
  try {
    outcome = await runOperation(loaded.api, op, checked.value, { timeoutMs: d.config.upstreamTimeoutMs });
    await insertCall(d.sql, {
      kind: "credit", creditTokenId: tokenId, apiId: loaded.api.id, opId: op.row.op_id, ruleId: ruleRow.id,
      execution: outcome.execution, verdict: outcome.verdict, reasons: outcome.reasons, latencyMs: outcome.latencyMs,
      inputHash: inputHash(tokenId, checked.value),
      outputHash: outcome.result ? outputHash(tokenId, outcome.result.body) : null,
    });
  } catch (e) {
    pending.end(false);
    await releaseCredit(d.sql, tokenId);
    await finish(false);
    throw e;
  }

  if (outcome.execution === "upstream_ok" && outcome.verdict === "pass" && outcome.result) {
    pending.end(true);
    let served: number | null;
    try {
      if (reservation.remainingAfter === 0) await markExhaustedIfEmpty(d.sql, tokenId);
      served = await finish(true);
    } catch (e) {
      // Finding G5: the body was never sent, so the credit was not used. Give it back; the error handler answers 500.
      await releaseCredit(d.sql, tokenId).catch(() => {});
      await finish(false).catch(() => {});
      throw e;
    }
    if (served !== null) res.set(SIGN_NEXT_HEADER, String(served));
    res.status(200)
      .set(SELLER_BODY_HEADERS)
      .set("x-credits-remaining", String(reservation.remainingAfter))
      .type(outcome.result.contentType ?? "application/json")
      .send(outcome.result.body);
    return;
  }

  pending.end(false);
  await releaseCredit(d.sql, tokenId);
  await finish(false);
  res.set("x-credits-remaining", String(reservation.remainingAfter + 1));
  // The seller's quota ran out, not the promise: a free retry later, not a broken API.
  if (outcome.result?.status === 429) {
    if (outcome.retryAfter !== undefined) res.set("retry-after", String(outcome.retryAfter));
    res.status(503).json({ error: "upstream_rate_limited", reasons: outcome.reasons }); return;
  }
  if (outcome.execution === "timeout") { res.status(504).json({ error: "upstream_timeout", reasons: outcome.reasons }); return; }
  if (outcome.execution === "upstream_ok") {
    res.status(422).json({ error: "promise_not_met", reasons: outcome.reasons, ...(outcome.auth ? { auth: outcome.auth } : {}) }); return;
  }
  res.status(502).json({ error: "upstream_error", reasons: outcome.reasons });
}
