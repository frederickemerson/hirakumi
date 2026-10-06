import { Router } from "express";
import { inputHash, outputHash, sha256Hex } from "@hirakumi/core";
import { insertCall, markExhaustedIfEmpty, releaseCredit, reserveCredit } from "@hirakumi/db";
import type { AppDeps } from "./deps";
import { creditsRequiredBody, downBody, parseBearer } from "./http";
import { runOperation, type OperationOutcome } from "./upstream";

export function creditsRouter(d: AppDeps): Router {
  const r = Router();
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
      const reservation = await reserveCredit(d.sql, loaded.api.id, sha256Hex(bearer));
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
        throw e;
      }

      if (outcome.execution === "upstream_ok" && outcome.verdict === "pass" && outcome.result) {
        if (reservation.remainingAfter === 0) await markExhaustedIfEmpty(d.sql, tokenId);
        res.status(200)
          .set("x-credits-remaining", String(reservation.remainingAfter))
          .type(outcome.result.contentType ?? "application/json")
          .send(outcome.result.body);
        return;
      }

      await releaseCredit(d.sql, tokenId);
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
