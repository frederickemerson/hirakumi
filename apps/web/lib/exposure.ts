import {
  buildUpstreamRequest, classifyExposure, combineExposure, compileRule, safeFetch, UpstreamRedirectError, UpstreamTimeoutError,
  type Exposure, type UpstreamResult,
} from "@hirakumi/core";
import type { Sql } from "./db";
import { loadExposureTargets, storeExposure, type ExposureTarget } from "./repo/exposure";

/**
 * The leak check (@hirakumi/core classifyExposure): each sellable endpoint is called once, with the input its test
 * calls saved and WITHOUT the seller's key, the way a stranger would call it. It runs here on the web app, not on the
 * gateway, so the seller's API sees an outside address and not the one that carries its key. The request is built
 * by the same code as every gateway call (buildUpstreamRequest: the proven origin and folder only) and sent through
 * the SSRF-safe fetch (private addresses refused, redirects never followed, time and size capped).
 *
 * Publishing requires "protected": an API anyone can call for free would never sell through Hirakumi.
 */
const EXPOSURE_TIMEOUT_MS = 10_000;
/** Not the gateway's user agent: an API that lets that one through without a key is still open to anyone. */
const USER_AGENT = "hirakumi-leak-check/0.1";

type ExposureFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }, opts: { timeoutMs: number }) => Promise<UpstreamResult>;
let fetchOverride: ExposureFetch | null = null;
/** Tests only: answer the leak check's calls without the network. */
export function setExposureFetchForTests(f: ExposureFetch | null): void {
  fetchOverride = f;
}

export type EndpointExposure = {
  opId: string;
  method: string;
  path: string;
  /** The URL that was called (no key in it: none is sent), or null when the request could not be built. */
  url: string | null;
  exposure: Exposure;
  /** For an open endpoint, what a stranger got; for an unknown one, why it could not be told. In plain words. */
  detail: string;
};
export type ExposureReport = { exposure: Exposure; endpoints: EndpointExposure[]; checkedAt: string };

async function checkEndpoint(api: { origin: string; pathPrefix: string }, t: ExposureTarget): Promise<EndpointExposure> {
  const method = t.method.toUpperCase();
  const base = { opId: t.opId, method, path: t.path };
  let req: ReturnType<typeof buildUpstreamRequest>;
  try {
    // No credential: the call goes out exactly as a buyer's would, minus the key.
    req = buildUpstreamRequest({ origin: api.origin, path_prefix: api.pathPrefix }, t, t.input ?? {}, t.rule?.contentType);
  } catch {
    return { ...base, url: null, exposure: "unknown", detail: `${method} ${t.path} could not be called with its saved test input` };
  }
  req.init.headers["user-agent"] = USER_AGENT;
  const where = `${method} ${req.url}`;
  let result: UpstreamResult;
  try {
    result = await (fetchOverride ?? safeFetch)(req.url, req.init, { timeoutMs: EXPOSURE_TIMEOUT_MS });
  } catch (e) {
    const detail = e instanceof UpstreamTimeoutError
      ? `${where} did not answer within ${EXPOSURE_TIMEOUT_MS / 1000} seconds`
      : e instanceof UpstreamRedirectError
        ? `${where} answered with a redirect (${e.status})`
        : `${where} could not be reached`;
    return { ...base, url: req.url, exposure: "unknown", detail };
  }
  let rule = null;
  try {
    rule = t.rule ? compileRule(t.rule) : null;
  } catch { /* a promise too old to compile: any 2xx then counts as a good answer */ }
  const exposure = classifyExposure(result, rule);
  return { ...base, url: req.url, exposure, detail: `${where} answered ${result.status}` };
}

/** Runs the leak check on every enabled endpoint and stores the result. Null when the API is gone. */
export async function checkExposure(sql: Sql, apiId: string): Promise<ExposureReport | null> {
  const loaded = await loadExposureTargets(sql, apiId);
  if (!loaded) return null;
  const endpoints = await Promise.all(loaded.targets.map((t) => checkEndpoint(loaded, t)));
  const exposure = combineExposure(endpoints.map((e) => e.exposure));
  await storeExposure(sql, apiId, exposure);
  return { exposure, endpoints, checkedAt: new Date().toISOString() };
}

/**
 * Why the report blocks publishing, in plain words, or null when every endpoint is protected. An open endpoint names
 * the URL anyone can call; an unknown result never passes silently and asks the seller to check again.
 */
export function exposureRefusal(report: ExposureReport): string | null {
  if (report.exposure === "protected") return null;
  const open = report.endpoints.find((e) => e.exposure === "open");
  if (open) {
    return `Anyone can call this API for free at ${open.url}, so nobody would pay through Hirakumi. ` +
      "Make your API require a key and add it on this page.";
  }
  const unknown = report.endpoints.find((e) => e.exposure === "unknown");
  const why = unknown ? `${unknown.detail}. ` : "There is no endpoint to check. ";
  return `We couldn't confirm that your API refuses calls without its key, so it can't be published yet. ${why}` +
    "Check again in a minute.";
}
