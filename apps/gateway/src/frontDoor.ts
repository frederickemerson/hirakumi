import type { RequestHandler } from "express";
import { matchOperation, normalizeHost, pathAfterPrefix } from "@hirakumi/core";
import { handlePaidCall } from "./credits";
import type { AppDeps } from "./deps";
import { isServed } from "./domains";
import { HOP_HEADER } from "./upstream";

/** Every front-door answer names the API it came from: the routed check reads it (internal.ts). */
export const API_HEADER = "x-hirakumi-api";

/**
 * Hosts that are always Hirakumi's own routes: the public gateway host, and anything that can't be a seller's
 * hostname (no Host, an IP address, a single label such as "gateway" or "localhost" on the internal network).
 * A seller's hostname is a public DNS name with a dot, the same rule api_domains holds (migration 0020).
 */
export function isNativeHost(host: string | null, publicHost: string): boolean {
  return host === null || !host.includes(".") || host === publicHost;
}

/**
 * The front door, mounted before every other route. A request to a seller's hostname (api.seller.com, pointed at
 * Hirakumi by DNS) is matched to one of that seller's live APIs by path and method and sold like a call to
 * /a/:apiId/x/:opId: no token, the 402 offer; a pack token, the call. Such a request never reaches another route,
 * so /internal, /a and /healthz exist only on Hirakumi's own host. The Host header only picks a listing: no URL,
 * redirect or cache key is ever built from it.
 */
export function frontDoor(d: AppDeps): RequestHandler {
  const publicHost = new URL(d.config.publicBaseUrl).hostname.toLowerCase();
  const listingUrl = (apiId: string) => (d.config.webBaseUrl ? { listingUrl: `${d.config.webBaseUrl}/p/${apiId}` } : {});
  return async (req, res, next) => {
    // Our own upstream call came back to the gateway, on any host or route: an origin that routes to Hirakumi
    // would loop. Every upstream call carries the header, so this is exact; sites that only share our IP (other
    // Caddy sites) never reach the gateway and are unaffected.
    if (req.header(HOP_HEADER)) {
      res.set("cache-control", "no-store").status(508)
        .json({ error: "loop_detected", message: "This request came from Hirakumi itself, so it was not sent on again." });
      return;
    }
    const host = normalizeHost(req.headers.host);
    if (isNativeHost(host, publicHost)) { next(); return; }
    try {
      res.set("cache-control", "no-store");
      const route = d.domains ? await d.domains.get(host!) : null;
      if (!isServed(route)) {
        res.status(421).json({ error: "misdirected_request", message: "This hostname is not served by Hirakumi." });
        return;
      }
      let found: { apiId: string; rest: string } | null = null;
      for (const a of route.apis) {
        const rest = pathAfterPrefix(a.pathPrefix, req.path);
        if (rest !== null) { found = { apiId: a.id, rest }; break; }
      }
      const loaded = found ? await d.registry.get(found.apiId) : null;
      if (!found || !loaded || loaded.api.state !== "live" || loaded.api.seller_id !== route.sellerId) {
        res.status(404).json({ error: "not_found", message: "Nothing is sold at this path through Hirakumi." });
        return;
      }
      res.set(API_HEADER, loaded.api.id);
      const ops = [...loaded.ops.values()].filter((o) => o.row.enabled);
      const match = matchOperation(ops.map((o) => ({ method: o.row.method, path: o.row.path, op: o })), req.method, found.rest);
      if (match.kind === "bad_path") { res.status(400).json({ error: "invalid_path", message: match.reason }); return; }
      if (match.kind === "not_found") {
        res.status(404).json({ error: "operation_not_found", message: "This API has no endpoint at this path.", ...listingUrl(loaded.api.id) });
        return;
      }
      if (match.kind === "method_not_allowed") {
        res.status(405).set("allow", match.allow.join(", ")).json({ error: "method_not_allowed", allow: match.allow });
        return;
      }
      // The shared input convention, in reverse (upstream.ts buildUpstreamRequest): path parameters and the query
      // are fields, and a JSON request body is the field `body`.
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(req.query)) {
        Object.defineProperty(input, k, { value: v, enumerable: true, writable: true, configurable: true });
      }
      for (const [k, v] of Object.entries(match.params)) {
        Object.defineProperty(input, k, { value: v, enumerable: true, writable: true, configurable: true });
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined
        && !(typeof req.body === "object" && req.body !== null && !Array.isArray(req.body) && Object.keys(req.body).length === 0 && !req.is("json"));
      if (hasBody) input.body = req.body;
      await handlePaidCall(d, loaded, match.op.op, input, req, res, { via: "front_door" });
    } catch (e) {
      next(e);
    }
  };
}
