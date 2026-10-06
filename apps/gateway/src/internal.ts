import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import {
  checkSpecBinding, firstServerUrl, MAX_RESPONSE_BYTES, readSpec, safeFetch, UpstreamBlockedError, UpstreamRedirectError,
  UpstreamTimeoutError, UpstreamTooLargeError, verifyDocField, VERIFY_FIELD,
} from "@hirakumi/core";
import { getOpenVerifyCode, getOwnershipTarget, insertCall } from "@hirakumi/db";
import type { AppDeps } from "./deps";
import { runOperation } from "./upstream";

export type OwnershipReason =
  | "verified" | "no_code" | "bad_url" | "origin_mismatch" | "outside_directory" | "redirect" | "blocked"
  | "timeout" | "too_large" | "unreachable" | "http_status" | "unreadable" | "missing" | "mismatch";
export type OwnershipCheck = { ok: boolean; reason: OwnershipReason; triedUrl: string; detail: string; status?: number };

async function checkOwnership(
  d: AppDeps,
  target: { id: string; origin: string; path_prefix: string; openapi_url: string },
): Promise<OwnershipCheck> {
  const triedUrl = target.openapi_url;
  const fail = (reason: OwnershipReason, detail: string, status?: number): OwnershipCheck =>
    ({ ok: false, reason, triedUrl, detail, ...(status === undefined ? {} : { status }) });
  // Same origin, and the base path under the spec's directory, before anything is fetched.
  const binding = checkSpecBinding({ openapiUrl: target.openapi_url, origin: target.origin, pathPrefix: target.path_prefix });
  if (!binding.ok) return fail(binding.reason, binding.detail);
  const code = await getOpenVerifyCode(d.sql, target.id);
  if (!code) return fail("no_code", "This API has no verification code yet. Open the ownership page to get one.");
  let got;
  try {
    got = await safeFetch(triedUrl, { method: "GET", headers: { accept: "application/json, application/yaml, text/yaml, */*" } },
      { timeoutMs: 10_000, maxBytes: MAX_RESPONSE_BYTES });
  } catch (e) {
    if (e instanceof UpstreamRedirectError) {
      return fail("redirect", `Your server answered ${e.status} (a redirect). Hirakumi does not follow redirects. Serve the file at this exact URL.`, e.status);
    }
    if (e instanceof UpstreamBlockedError) return fail("blocked", `This address is not allowed: ${e.message}`);
    if (e instanceof UpstreamTimeoutError) return fail("timeout", "Your server did not answer within 10 seconds.");
    if (e instanceof UpstreamTooLargeError) return fail("too_large", "The file is over 1 MB.");
    return fail("unreachable", `Could not reach your server: ${(e as Error).message}`);
  }
  if (got.status !== 200) return fail("http_status", `Your server answered ${got.status}, not 200.`, got.status);
  const doc = readSpec(got.body);
  if (!doc) return fail("unreadable", "The file is not valid JSON or YAML.");
  // Re-check the binding against the servers[0] the file declares now.
  const current = checkSpecBinding({
    openapiUrl: target.openapi_url, origin: target.origin, pathPrefix: target.path_prefix, serverUrl: firstServerUrl(doc.servers),
  });
  if (!current.ok) return fail(current.reason, current.detail);
  const field = verifyDocField(doc, code.token);
  if (field.kind === "missing") return fail("missing", `We read your OpenAPI file, but it has no ${VERIFY_FIELD} field at the root.`);
  if (field.kind === "mismatch") return fail("mismatch", `Found ${VERIFY_FIELD}, but its value does not match this API's code. Copy the code shown on this page.`);
  return { ok: true, reason: "verified", triedUrl, detail: "Found your code. The OpenAPI file is verified." };
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
      res.json({ ...outcome.result, ...(op.rule ? { verdict: { pass: outcome.verdict === "pass", reasons: outcome.reasons } } : {}) });
    } catch (e) { next(e); }
  });

  // Ownership proof: the API's own code at the root of its OpenAPI file (x-hirakumi-verify), served from a
  // directory that covers the API's base path on the same origin. Read-only (contract v1.1 D3): the web app
  // records the pass and consumes the code when ownership is finalised.
  r.post("/internal/challenge/:apiId/check", async (req, res, next) => {
    try {
      const target = await getOwnershipTarget(d.sql, req.params.apiId);
      if (!target) { res.status(404).json({ error: "api_not_found" }); return; }
      res.json(await checkOwnership(d, target));
    } catch (e) { next(e); }
  });

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
