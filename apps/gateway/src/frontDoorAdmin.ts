import { Router } from "express";
import express from "express";
import { isIP } from "node:net";
import { normalizeHost, type StoredUpstreamAuth } from "@hirakumi/core";
import {
  activateDomain, attachFrontDoor, detachApiFrontDoor, getDomainRoute, getFrontDoorState, getProvenVerifyCode, loadProbeInputs,
  noteDomainError, originHost, type FrontDoorLimits,
} from "@hirakumi/db";
import type { AppDeps } from "./deps";
import { addressResolverVia, checkRouted, frontDoorProbeVia, isServed, tlsAskDecision, type DomainRegistry } from "./domains";
import { probeVerifyDns, txtLookupVia } from "./ownership";
import { openCredential } from "./registry";
import { runOperation } from "./upstream";

/** The DNS record a seller adds: a CNAME to the sslip.io name of our first edge address, or an A record for an apex. */
export function dnsTargetFor(edgeIps: readonly string[]): { cname: string | null; a: string | null; aaaa: string | null } {
  const v4 = edgeIps.find((ip) => isIP(ip) === 4) ?? null;
  const v6 = edgeIps.find((ip) => isIP(ip) === 6) ?? null;
  return { cname: v4 ? `${v4.replace(/\./g, "-")}.sslip.io` : null, a: v4, aaaa: v6 };
}

/** One test call per endpoint must pass before the gateway switches to a new origin. */
export type OriginTest = { opId: string; ok: boolean; detail: string };

/**
 * The front door's internal routes (the web app calls them with INTERNAL_TOKEN, mounted under /internal by
 * internal.ts): the API's front-door state, the origin switch, the routed check, stop, and cache reloads.
 */
export function frontDoorAdminRoutes(d: AppDeps, r: Router, limits?: FrontDoorLimits): void {
  const lookup = () => d.txtLookup ?? txtLookupVia(d.config.dnsResolvers);
  const reloadHost = (host: string | null) => { if (host) d.domains?.invalidate(host); };

  r.get("/internal/front-door/:apiId", async (req, res, next) => {
    try {
      const state = await getFrontDoorState(d.sql, req.params.apiId);
      if (!state) { res.status(404).json({ error: "api_not_found" }); return; }
      res.json({
        origin: state.origin, publicHost: state.publicHost,
        domain: state.domain && { ...state.domain, txtVerifiedAt: state.domain.txtVerifiedAt?.toISOString() ?? null, routedAt: state.domain.routedAt?.toISOString() ?? null },
        dnsTarget: dnsTargetFor(d.config.edgeIps),
      });
    } catch (e) { next(e); }
  });

  /**
   * Moves the API to a new origin behind the front door: its own _hirakumi TXT (the API's proven code) must be at the
   * new hostname and still at the old one, and one test call per endpoint at the new origin, with the key, must keep
   * the promise. Then, in one transaction, the origin and key change and the old hostname becomes a pending domain.
   */
  r.post("/internal/front-door/:apiId/origin", async (req, res, next) => {
    try {
      const apiId = req.params.apiId;
      const body = (req.body ?? {}) as { origin?: unknown; upstreamAuth?: unknown };
      const state = await getFrontDoorState(d.sql, apiId);
      if (!state) { res.status(404).json({ error: "api_not_found" }); return; }
      const fail = (status: number, error: string, detail: string, extra: Record<string, unknown> = {}) => {
        res.status(status).json({ ok: false, error, detail, ...extra });
      };
      if (state.state === "retired") { fail(409, "retired", "This API was removed from Hirakumi."); return; }
      if (state.publicHost) { fail(409, "already_attached", `This API already uses the front door on ${state.publicHost}. Stop it first to change the origin.`); return; }
      let newOrigin: URL;
      try {
        newOrigin = new URL(String(body.origin ?? ""));
      } catch {
        fail(400, "bad_origin", "Give the new origin as a URL, like https://origin.example.com."); return;
      }
      if (newOrigin.protocol !== "https:" && !(process.env.ALLOW_INSECURE_UPSTREAM === "1" && newOrigin.protocol === "http:")) {
        fail(400, "bad_origin", "The new origin must start with https://."); return;
      }
      if (newOrigin.username || newOrigin.password || (newOrigin.pathname !== "/" && newOrigin.pathname !== "") || newOrigin.search || newOrigin.hash) {
        fail(400, "bad_origin", "Give only the scheme and hostname, like https://origin.example.com. Your API's folder stays the same."); return;
      }
      const publicHost = normalizeHost(originHost(state.origin));
      const nextHost = normalizeHost(newOrigin.host);
      if (!publicHost || !publicHost.includes(".")) { fail(400, "bad_public_host", "This API's address has no domain name, so it can't have a front door."); return; }
      if (!nextHost || !nextHost.includes(".")) { fail(400, "bad_origin", "The new origin needs a domain name, like origin.example.com."); return; }
      if (nextHost === publicHost) { fail(400, "same_host", `The new origin must be another hostname than ${publicHost}: that one will point at Hirakumi.`); return; }
      const stored = parseStoredAuth(body.upstreamAuth);
      if (!stored) { fail(400, "key_required", "The front door needs your API's key, so only Hirakumi can call the new origin."); return; }
      const code = await getProvenVerifyCode(d.sql, apiId);
      if (!code) { fail(409, "no_proof", "This API has no DNS ownership proof to reuse. Prove ownership with a DNS record first."); return; }
      const origin = newOrigin.origin;
      const [atOrigin, atPublic] = await Promise.all([probeVerifyDns(origin, code, lookup()), probeVerifyDns(state.origin, code, lookup())]);
      if (!atOrigin.ok) { fail(422, "origin_txt", atOrigin.detail, { record: atOrigin.record, code, reason: atOrigin.reason }); return; }
      if (!atPublic.ok) { fail(422, "public_txt", atPublic.detail, { record: atPublic.record, reason: atPublic.reason }); return; }

      const access = openCredential({ id: apiId, upstream_auth: stored, origin, path_prefix: state.pathPrefix }, d.config.upstreamAuthPrivateKey);
      if (access.credentialError || !access.credential) { fail(400, "key_unreadable", access.credentialError ?? "The key could not be read. Enter it again."); return; }
      const loaded = await d.registry.get(apiId, { fresh: true });
      if (!loaded) { fail(404, "api_not_found", "This API was not found."); return; }
      const inputs = await loadProbeInputs(d.sql, apiId);
      const api = { ...loaded.api, origin, ...access };
      const tests: OriginTest[] = [];
      for (const op of loaded.ops.values()) {
        if (!op.row.enabled) continue;
        const saved = inputs.find((i) => i.op_id === op.row.op_id);
        if (!saved) continue;
        const checked = op.validateInput(saved.input);
        const outcome = await runOperation(api, op, checked.ok ? checked.value : (saved.input as Record<string, unknown>), { timeoutMs: d.config.upstreamTimeoutMs });
        const status = outcome.result?.status ?? 0;
        const ok = outcome.execution === "upstream_ok" && (outcome.verdict === "pass" || (outcome.verdict === "n/a" && status >= 200 && status < 300));
        tests.push({ opId: op.row.op_id, ok, detail: ok ? `answered ${status} and kept the promise` : (outcome.reasons[0] ?? outcome.execution) });
      }
      if (tests.length === 0) { fail(409, "no_tests", "This API has no saved test call to try the new origin with."); return; }
      if (tests.some((t) => !t.ok)) { fail(422, "tests_failed", "Test calls to the new origin did not all pass.", { tests }); return; }

      const attached = await attachFrontDoor(d.sql, { apiId, expectedOrigin: state.origin, newOrigin: origin, publicHost, upstreamAuth: stored, limits });
      if (!attached.ok) { fail(409, attached.reason, attached.detail); return; }
      d.registry.invalidate(apiId);
      reloadHost(attached.host);
      res.json({ ok: true, host: attached.host, origin, tests, dnsTarget: dnsTargetFor(d.config.edgeIps) });
    } catch (e) { next(e); }
  });

  /**
   * Check connection: the host resolves only to EDGE_IPS (A and AAAA, after any CNAME), then one HTTPS request to it
   * comes back from the front door naming one of its APIs. Then the domain is active. A failure is noted, never counted.
   */
  r.post("/internal/domains/:host/check", async (req, res, next) => {
    try {
      const host = normalizeHost(req.params.host);
      const route = host ? await getDomainRoute(d.sql, host) : null;
      if (!host || !isServed(route) || route.apis.length === 0) { res.status(404).json({ error: "domain_not_found" }); return; }
      const routed = await checkRouted(d.addressResolver ?? addressResolverVia(d.config.dnsResolvers), host, d.config.edgeIps);
      if (routed.outcome !== "routed") {
        await noteDomainError(d.sql, host, routed.detail);
        res.json({ ok: false, outcome: routed.outcome, detail: routed.detail, chain: routed.chain, addresses: routed.addresses });
        return;
      }
      const probe = d.frontDoorProbe ?? frontDoorProbeVia(d.config.edgeIps.find((ip) => isIP(ip) === 4) ?? d.config.edgeIps[0]);
      const first = route.apis[0];
      let answer: { status: number; apiId: string | null };
      try {
        answer = await probe(host, `${first.pathPrefix.replace(/\/+$/, "")}/`);
      } catch (e) {
        const detail = `${host} points at Hirakumi, but HTTPS did not answer yet (${(e as Error).message}). The certificate can take a minute.`;
        await noteDomainError(d.sql, host, detail);
        res.json({ ok: false, outcome: "no_answer", detail, chain: routed.chain, addresses: routed.addresses });
        return;
      }
      if (!answer.apiId || !route.apis.some((a) => a.id === answer.apiId)) {
        const detail = `${host} answered ${answer.status}, but not from Hirakumi's front door.`;
        await noteDomainError(d.sql, host, detail);
        res.json({ ok: false, outcome: "no_answer", detail, chain: routed.chain, addresses: routed.addresses });
        return;
      }
      await activateDomain(d.sql, host, new Date(Date.now() + d.config.domainRecheckMs));
      reloadHost(host);
      res.json({ ok: true, outcome: "routed", detail: `${host} is answered by Hirakumi.`, chain: routed.chain, addresses: routed.addresses });
    } catch (e) { next(e); }
  });

  /** Stop using the front door: the API keeps its origin and key; the host is detached (no certificate, 421). */
  r.post("/internal/front-door/:apiId/stop", async (req, res, next) => {
    try {
      const out = await detachApiFrontDoor(d.sql, req.params.apiId);
      reloadHost(out?.host ?? null);
      d.registry.invalidate(req.params.apiId);
      res.json({ ok: true, host: out?.host ?? null });
    } catch (e) { next(e); }
  });

  r.post("/internal/domains/:host/reload", (req, res) => {
    reloadHost(normalizeHost(req.params.host));
    res.json({ ok: true });
  });
}

function parseStoredAuth(v: unknown): StoredUpstreamAuth | null {
  const o = v as Partial<StoredUpstreamAuth> | null;
  if (!o || typeof o !== "object") return null;
  if ((o.in !== "header" && o.in !== "query") || typeof o.name !== "string" || typeof o.sealed !== "string" || !o.sealed) return null;
  return { in: o.in, name: o.name, sealed: o.sealed, hint: typeof o.hint === "string" ? o.hint : "" };
}

/**
 * The listener only Caddy reaches (TLS_ASK_PORT, compose `expose`): GET /tls-ask?domain=<name> answers 200 when
 * Caddy may get a certificate for the name (a served front-door host with a verified TXT), else 403.
 */
export function tlsAskApp(domains: DomainRegistry): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/tls-ask", async (req, res) => {
    try {
      const domain = typeof req.query.domain === "string" ? req.query.domain : undefined;
      if (await tlsAskDecision(domains, domain)) res.status(200).send("ok");
      else res.status(403).send("no");
    } catch (e) {
      console.error("[tls-ask]", e);
      res.status(503).send("error");
    }
  });
  app.use((_req, res) => { res.status(404).send("not found"); });
  return app;
}
