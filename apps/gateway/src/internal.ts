import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { StoredUpstreamAuth } from "@hirakumi/core";
import { getOpenVerifyCode, getOwnershipTarget, insertCall, loadProbeInputs, type ApiState } from "@hirakumi/db";
import { demoBuyPack } from "./demoBuy";
import { frontDoorAdminRoutes } from "./frontDoorAdmin";
import { SELLER_BODY_HEADERS } from "./http";
import type { AppDeps } from "./deps";
import { createWindowLimiter } from "./limiter";
import { probeVerifyDns, txtLookupVia, type DnsCheck } from "./ownership";
import { openCredential, type LoadedApi, type LoadedOp } from "./registry";
import { canEscrow, forgetSettlementSignals, policyFor } from "./settlement";
import { KEY_WITHHELD_TEXT, resolveAuth, runOperation, type OperationOutcome } from "./upstream";

/**
 * The ownership check of the web app's proof step: the API's open code (kind 'dns') in the TXT record at
 * `_hirakumi.<host>`. The same lookup as the monitor's re-check (ownership.ts probeVerifyDns).
 */
async function checkOwnership(d: AppDeps, target: { id: string; origin: string }): Promise<DnsCheck> {
  const code = await getOpenVerifyCode(d.sql, target.id);
  return probeVerifyDns(target.origin, code?.token ?? null, d.txtLookup ?? txtLookupVia(d.config.dnsResolvers));
}

/** What a key check found. "unchecked" means no call was made (see `why`). */
export type CheckKeyClass =
  | "ok" | "accepted_unverified" | "refused" | "forbidden" | "rate_limited" | "timeout" | "echoed" | "unclear" | "unchecked";
export type CheckKeyResult = {
  opened: boolean; class: CheckKeyClass; status?: number; op?: string; reasons?: string[]; why?: "not_proven" | "no_test_input";
};

/** States from ownership proof onward: only then is the API's address known to be the seller's, so a call may go there. */
const PROVEN_STATES: ReadonlySet<ApiState> = new Set(["ownership_verified", "rule_built", "priced", "registering", "live"]);
/** A check-key call waits at most this long, so the web app's save never hangs on a slow API. */
export const CHECK_KEY_TIMEOUT_MS = 15_000;

/**
 * The operation and input a key check calls: an enabled operation with a promise and a saved test input, else any
 * enabled operation with a saved test input, else an enabled GET that needs no input at all (called with {}).
 */
async function chooseCheckOp(d: AppDeps, loaded: LoadedApi): Promise<{ op: LoadedOp; input: Record<string, unknown> } | null> {
  const inputs = await loadProbeInputs(d.sql, loaded.api.id);
  const withInput = inputs.map((t) => ({ op: loaded.ops.get(t.op_id), input: t.input })).filter((x) => x.op?.row.enabled);
  const pick = withInput.find((x) => x.op!.rule) ?? withInput[0];
  if (pick) {
    const checked = pick.op!.validateInput(pick.input);
    return { op: pick.op!, input: checked.ok ? checked.value : (pick.input as Record<string, unknown>) };
  }
  for (const op of loaded.ops.values()) {
    if (!op.row.enabled || op.row.method.toUpperCase() !== "GET" || op.row.path.includes("{")) continue;
    const checked = op.validateInput({});
    if (checked.ok) return { op, input: checked.value };
  }
  return null;
}

/** The class of one check call. A withheld answer is "echoed" whatever its status, since its status is not kept. */
export function classifyCheck(outcome: OperationOutcome): CheckKeyClass {
  const status = outcome.result?.status;
  if (outcome.execution === "timeout") return "timeout";
  if (outcome.execution === "upstream_error" && !outcome.result && outcome.reasons.includes(KEY_WITHHELD_TEXT)) return "echoed";
  if (outcome.auth === "refused" || status === 401) return "refused";
  if (outcome.auth === "forbidden" || status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (outcome.execution === "upstream_ok" && outcome.verdict === "pass") return "ok";
  if (outcome.execution === "upstream_ok" && outcome.verdict === "n/a" && status !== undefined && status >= 200 && status < 300) return "accepted_unverified";
  return "unclear";
}

/**
 * POST /internal/apis/:apiId/check-key {stored?}: does the API accept this key? Opens the sealed key the web app
 * sends (or the saved one) under the row's own address, makes one real call on the seller's test input and answers
 * with a class, the HTTP status and the redacted reasons, never the answer's body. Nothing is stored: no calls row,
 * no health change. Only an API whose address is proven is called.
 */
async function checkKey(d: AppDeps, apiId: string, stored: unknown): Promise<CheckKeyResult | null> {
  const loaded = await d.registry.get(apiId, { fresh: true });
  if (!loaded) return null;
  const toOpen = (stored ?? loaded.api.upstream_auth) as StoredUpstreamAuth | null;
  if (!toOpen || typeof toOpen !== "object") return { opened: false, class: "unchecked" };
  let access: ReturnType<typeof openCredential>;
  try {
    access = openCredential({ ...loaded.api, upstream_auth: toOpen }, d.config.upstreamAuthPrivateKey);
  } catch {
    return { opened: false, class: "unchecked" };
  }
  // Only the opened candidate is the key: an hks2 key has no `auth`, so a saved bag's must not carry over.
  const api = { ...loaded.api, credential: access.credential, credentialError: access.credentialError, auth: access.auth };
  if (access.credentialError || !resolveAuth(api)) return { opened: false, class: "unchecked" };
  if (!PROVEN_STATES.has(loaded.api.state)) return { opened: true, class: "unchecked", why: "not_proven" };
  const chosen = await chooseCheckOp(d, loaded);
  if (!chosen) return { opened: true, class: "unchecked", why: "no_test_input" };
  const outcome = await runOperation(api, chosen.op, chosen.input, {
    timeoutMs: Math.min(d.config.upstreamTimeoutMs, CHECK_KEY_TIMEOUT_MS), probe: true,
  });
  const cls = classifyCheck(outcome);
  const status = cls === "echoed" ? undefined : outcome.result?.status;
  return {
    opened: true, class: cls, op: chosen.op.row.op_id,
    ...(status !== undefined ? { status } : {}),
    ...(cls !== "ok" && outcome.reasons.length ? { reasons: outcome.reasons.slice(0, 5) } : {}),
  };
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
  // Each check is a real call to the seller's API: at most 6 a minute per API.
  const checkLimit = createWindowLimiter(6, 60_000);

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

  r.post("/internal/apis/:apiId/check-key", async (req, res, next) => {
    try {
      if (!checkLimit(req.params.apiId)) {
        res.status(429).set("retry-after", "60").json({ error: "too_many_checks" });
        return;
      }
      const result = await checkKey(d, req.params.apiId, (req.body as { stored?: unknown } | undefined)?.stored);
      if (!result) { res.status(404).json({ error: "api_not_found" }); return; }
      res.json(result);
    } catch (e) { next(e); }
  });

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

  frontDoorAdminRoutes(d, r);

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
