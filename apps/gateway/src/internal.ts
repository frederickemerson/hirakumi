import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { httpChallengePath, safeFetch, UpstreamBlockedError, UpstreamTimeoutError } from "@hirakumi/core";
import { getActiveHttpChallenge, insertCall } from "@hirakumi/db";
import { demoBuyPack } from "./demoBuy";
import type { AppDeps } from "./deps";
import { runOperation } from "./upstream";

const digest = (s: string) => createHash("sha256").update(s).digest();

function requireInternalToken(token: string): RequestHandler {
  const expected = digest(`Bearer ${token}`);
  return (req, res, next) => {
    if (!timingSafeEqual(digest(req.header("authorization") ?? ""), expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function internalRouter(d: AppDeps): Router {
  const r = Router();
  r.use("/internal", requireInternalToken(d.config.internalToken));

  r.post("/internal/preview/:apiId/:opId", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId, { fresh: true });
      const op = loaded?.ops.get(req.params.opId);
      if (!loaded || !op) { res.status(404).json({ error: "operation_not_found" }); return; }
      const checked = op.validateInput((req.body as { input?: unknown } | undefined)?.input);
      if (!checked.ok) { res.status(400).json({ error: "invalid_input", reasons: checked.reasons }); return; }
      const outcome = await runOperation(loaded.api, op, checked.value, { timeoutMs: d.config.upstreamTimeoutMs });
      await insertCall(d.sql, {
        kind: "preview", apiId: loaded.api.id, opId: op.row.op_id, ruleId: op.ruleRow?.id ?? null,
        execution: outcome.execution, verdict: outcome.verdict, reasons: outcome.reasons, latencyMs: outcome.latencyMs,
      });
      if (outcome.execution === "blocked") { res.status(400).json({ error: "blocked", detail: outcome.reasons[0] }); return; }
      if (outcome.execution === "timeout") { res.status(504).json({ error: "upstream_timeout", detail: outcome.reasons[0] }); return; }
      if (!outcome.result) { res.status(502).json({ error: "upstream_error", detail: outcome.reasons[0] }); return; }
      res.json({ ...outcome.result, ...(op.rule ? { verdict: { pass: outcome.verdict === "pass", reasons: outcome.reasons } } : {}) });
    } catch (e) { next(e); }
  });

  r.post("/internal/challenge/:apiId/check", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId, { fresh: true });
      if (!loaded) { res.status(404).json({ error: "api_not_found" }); return; }
      const triedUrl = new URL(httpChallengePath(loaded.api.id), loaded.api.origin).toString();
      const challenge = await getActiveHttpChallenge(d.sql, loaded.api.id);
      if (!challenge) {
        res.json({ ok: false, triedUrl, detail: "There is no open ownership challenge. Download a new challenge file and try again." });
        return;
      }
      let detail: string;
      try {
        const got = await safeFetch(triedUrl, { method: "GET", headers: { accept: "text/plain" } }, { timeoutMs: 10_000, maxBytes: 4096 });
        if (got.status !== 200) {
          detail = `Your server answered ${got.status} instead of 200. Upload the file to exactly this address.`;
        } else if (got.body.trim() !== challenge.token.trim()) {
          detail = "The file was found, but its contents do not match the challenge. Upload the file you downloaded, unchanged.";
        } else {
          // Read-only (contract v1.1 D3): the web app records the pass and consumes the row at finalisation.
          res.json({ ok: true, triedUrl, detail: "Ownership file verified." });
          return;
        }
      } catch (e) {
        if (e instanceof UpstreamBlockedError) detail = `This address is not allowed: ${e.message}`;
        else if (e instanceof UpstreamTimeoutError) detail = "Your server did not answer within 10 seconds.";
        else detail = `Could not reach your server: ${(e as Error).message}`;
      }
      res.json({ ok: false, triedUrl, detail });
    } catch (e) { next(e); }
  });

  r.post("/internal/demo/buy-pack/:apiId", demoBuyPack(d));

  r.post("/internal/apis/:apiId/reload", (req, res) => {
    d.registry.invalidate(req.params.apiId);
    res.json({ ok: true });
  });

  r.get("/internal/apis/:apiId/health", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded) { res.status(404).json({ error: "api_not_found" }); return; }
      const snap = d.health.get(loaded.api.id);
      res.json({
        health: snap?.health ?? loaded.api.health,
        checkedAt: (snap?.checkedAt ?? loaded.api.health_checked_at)?.toISOString() ?? null,
        lastReasons: (snap?.lastReasons ?? []).map((x) => `${x.op}: ${x.reason}`),
      });
    } catch (e) { next(e); }
  });

  return r;
}
