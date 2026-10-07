import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { getOpenVerifyCode, getOwnershipTarget, insertCall } from "@hirakumi/db";
import { demoBuyPack } from "./demoBuy";
import { SELLER_BODY_HEADERS } from "./http";
import type { AppDeps } from "./deps";
import { probeVerifyDns, txtLookupVia, type DnsCheck } from "./ownership";
import { canEscrow, forgetSettlementSignals, policyFor } from "./settlement";
import { runOperation } from "./upstream";

/**
 * The ownership check of the web app's proof step: the API's open code (kind 'dns') in the TXT record at
 * `_hirakumi.<host>`. The same lookup as the monitor's re-check (ownership.ts probeVerifyDns).
 */
async function checkOwnership(d: AppDeps, target: { id: string; origin: string }): Promise<DnsCheck> {
  const code = await getOpenVerifyCode(d.sql, target.id);
  return probeVerifyDns(target.origin, code?.token ?? null, d.txtLookup ?? txtLookupVia(d.config.dnsResolvers));
}

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
      res.set(SELLER_BODY_HEADERS).json({ ...outcome.result, ...(op.rule ? { verdict: { pass: outcome.verdict === "pass", reasons: outcome.reasons } } : {}) });
    } catch (e) { next(e); }
  });

  // Ownership proof: the API's own code in the TXT record at _hirakumi.<host>. Read-only (contract v1.1 D3): the
  // web app records the pass and consumes the code when ownership is finalised.
  r.post("/internal/challenge/:apiId/check", async (req, res, next) => {
    try {
      const target = await getOwnershipTarget(d.sql, req.params.apiId);
      if (!target) { res.status(404).json({ error: "api_not_found" }); return; }
      res.json(await checkOwnership(d, target));
    } catch (e) { next(e); }
  });

  r.post("/internal/demo/buy-pack/:apiId", demoBuyPack(d));
  // A seller's one free test of their own live API (any API, not only TRY_LIVE_APIS); the web checks the seller.
  r.post("/internal/demo/self-test/:apiId", demoBuyPack(d, "self_test"));

  r.post("/internal/apis/:apiId/reload", (req, res) => {
    d.registry.invalidate(req.params.apiId);
    forgetSettlementSignals(d.sql, req.params.apiId);
    res.json({ ok: true });
  });

  /**
   * How a buyer who sends escrow headers would settle each pack right now (the public API page shows it).
   * Hybrid: the policy on live data; a 402 stores its own answer. direct / escrow: fixed by PACK_MODE, no reasons.
   */
  r.get("/internal/apis/:apiId/settlement", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded) { res.status(404).json({ error: "api_not_found" }); return; }
      const mode = d.config.packMode;
      const packs = await Promise.all(loaded.packs.map(async (pack) => {
        if (mode === "direct" || (mode === "escrow" && !d.config.packEscrow)) return { packId: pack.id, mode: "direct", reasons: [] };
        if (mode === "escrow") return { packId: pack.id, mode: "escrow", reasons: [] };
        const p = await policyFor(d, loaded, pack, true);
        return p.mode === "escrow" && !canEscrow(d, pack)
          ? { packId: pack.id, mode: "direct", reasons: p.reasons, recommended: "escrow" }
          : { packId: pack.id, mode: p.mode, reasons: p.reasons };
      }));
      res.json({ packMode: mode, packs });
    } catch (e) { next(e); }
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
