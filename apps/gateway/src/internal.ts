import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import {
  matchVerifyHeader, ownershipCheckUrl, safeFetchWithHeaders, UpstreamBlockedError, UpstreamTimeoutError,
  UpstreamTooLargeError, VERIFY_HEADER, type UpstreamProbe,
} from "@hirakumi/core";
import { getOpenVerifyCode, getOwnershipTarget, insertCall } from "@hirakumi/db";
import { demoBuyPack } from "./demoBuy";
import { SELLER_BODY_HEADERS } from "./http";
import type { AppDeps } from "./deps";
import { canEscrow, forgetSettlementSignals, policyFor } from "./settlement";
import { runOperation } from "./upstream";

export type OwnershipReason =
  | "verified" | "no_code" | "bad_url" | "blocked" | "timeout" | "unreachable" | "too_large" | "missing" | "mismatch";
export type OwnershipCheck = { ok: boolean; reason: OwnershipReason; triedUrl: string; detail: string; status?: number };

const OWNERSHIP_TIMEOUT_MS = 10_000;
/** Fixed, like every gateway call (upstream.ts): a request with no User-Agent is often stopped by a WAF before it reaches the seller's code. */
const OWNERSHIP_USER_AGENT = "hirakumi-gateway/0.1";

/**
 * One plain GET to the API's base URL: no query, no body, nothing the seller wrote, redirects not followed.
 * The header counts on any status, since only someone who controls the answers under the base can add it.
 * Only the status and headers are read, so a large or streaming page at the base still passes.
 */
async function checkOwnership(d: AppDeps, target: { id: string; origin: string; path_prefix: string }): Promise<OwnershipCheck> {
  // The code first: the URL guard refuses a base URL that carries it.
  const code = await getOpenVerifyCode(d.sql, target.id);
  const checkUrl = ownershipCheckUrl({ origin: target.origin, pathPrefix: target.path_prefix, code: code?.token ?? "" });
  const triedUrl = checkUrl.url;
  const fail = (reason: OwnershipReason, detail: string, status?: number): OwnershipCheck =>
    ({ ok: false, reason, triedUrl, detail, ...(status === undefined ? {} : { status }) });
  if (!code) return fail("no_code", "This API has no verification code yet. Open the ownership page to get one.");
  if (!checkUrl.ok) return fail("bad_url", checkUrl.detail);
  const timeoutMs = Math.min(OWNERSHIP_TIMEOUT_MS, d.config.upstreamTimeoutMs);
  const probe = async (url: string): Promise<UpstreamProbe | OwnershipCheck> => {
    try {
      return await safeFetchWithHeaders(url, { method: "GET", headers: { accept: "*/*", "user-agent": OWNERSHIP_USER_AGENT } }, { timeoutMs });
    } catch (e) {
      if (e instanceof UpstreamBlockedError) return fail("blocked", `This address is not allowed: ${e.message}`);
      if (e instanceof UpstreamTimeoutError) return fail("timeout", `Your server did not answer within ${timeoutMs / 1000} seconds.`);
      if (e instanceof UpstreamTooLargeError) return fail("too_large", "The answer at your base URL is over 1 MB.");
      return fail("unreachable", `Could not reach your server: ${(e as Error).message}`);
    }
  };
  let got = await probe(checkUrl.url);
  if ("reason" in got) return got;
  let tried = triedUrl;
  // Many servers redirect /v1 to /v1/ before any app code (and its header) runs. That one hop stays at the same
  // base, so it is followed once; any other redirect is not, because it would vouch for another address.
  const slashed = `${checkUrl.url}/`;
  if (matchVerifyHeader(got.headers[VERIFY_HEADER.toLowerCase()], code.token) === "missing" && got.status >= 300 && got.status < 400
    && !checkUrl.url.endsWith("/") && redirectTarget(got, checkUrl.url) === slashed) {
    const again = await probe(slashed);
    if ("reason" in again) return { ...again, triedUrl: slashed };
    got = again;
    tried = slashed;
  }
  const match = matchVerifyHeader(got.headers[VERIFY_HEADER.toLowerCase()], code.token);
  if (match === "missing") {
    return { ...fail("missing", `Your server answered ${got.status}, but without the ${VERIFY_HEADER} header.`, got.status), triedUrl: tried };
  }
  if (match === "mismatch") {
    return { ...fail("mismatch", `Found ${VERIFY_HEADER}, but its value does not match this API's code. Copy the code shown on this page.`, got.status), triedUrl: tried };
  }
  return { ok: true, reason: "verified", triedUrl: tried, detail: `Found your code in the ${VERIFY_HEADER} header.`, status: got.status };
}

/** Where a 3xx answer points, as an absolute URL, or null. */
function redirectTarget(got: UpstreamProbe, from: string): string | null {
  const loc = got.headers.location;
  const raw = Array.isArray(loc) ? loc[0] : loc;
  if (!raw) return null;
  try {
    return new URL(raw, from).toString();
  } catch {
    return null;
  }
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

  // Ownership proof: the API's own code in the X-Hirakumi-Verify response header at its base URL (origin +
  // path_prefix). Read-only (contract v1.1 D3): the web app records the pass and consumes the code when
  // ownership is finalised.
  r.post("/internal/challenge/:apiId/check", async (req, res, next) => {
    try {
      const target = await getOwnershipTarget(d.sql, req.params.apiId);
      if (!target) { res.status(404).json({ error: "api_not_found" }); return; }
      res.json(await checkOwnership(d, target));
    } catch (e) { next(e); }
  });

  r.post("/internal/demo/buy-pack/:apiId", demoBuyPack(d));

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
