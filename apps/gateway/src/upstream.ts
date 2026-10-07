import {
  isJsonMediaType, redactUpstreamSecret, safeFetch, textLeaksSecret, upstreamSecretForms, urlWithinBase, UpstreamBlockedError, UpstreamTimeoutError, type UpstreamCredential, type UpstreamResult,
} from "@hirakumi/core";
import type { ApiRow, OperationRow } from "@hirakumi/db";
import type { LoadedOp, UpstreamAccess } from "./registry";

/** Sent on every upstream call; a request that carries it is never routed out again (loop guard). */
export const HOP_HEADER = "x-hirakumi-hop";

/** The API as an upstream call needs it. Access is optional: an API without it needs no key. */
export type UpstreamApi = Pick<ApiRow, "origin" | "path_prefix"> & Partial<UpstreamAccess>;

/**
 * The common ways the key is written in an answer or a message that redaction can cut out (@hirakumi/core
 * upstreamSecretForms): the whole value and its parts (the bare token of "Bearer abc…"), each as is and
 * base64-encoded, percent-encoded, JSON-escaped and entity-escaped, lowercased (matching ignores case). Longest
 * first. leaksSecret also decodes the text, so it finds more than these.
 */
export const secretForms = upstreamSecretForms;

/**
 * True when text (an answer or one of its headers) contains the key in a common encoding, in any case: the forms
 * above, the text with escapes undone, and base64 tokens decoded (@hirakumi/core textLeaksSecret). Not every
 * encoding: a header key, which answers echo less often than URLs, is the safer default.
 */
export function leaksSecret(text: string | null | undefined, credential: UpstreamCredential | null | undefined): boolean {
  return !!credential && textLeaksSecret(text, credential.value);
}

/**
 * Removes the key from text that may reach a buyer, the database or a log (error messages can quote the URL). Text
 * where the key is found only after decoding is replaced whole.
 */
export function redactSecret(text: string, credential: UpstreamCredential | null | undefined): string {
  return credential ? redactUpstreamSecret(text, credential.value) : text;
}

/**
 * The Accept header for an operation. A JSON promise, or no promise yet (QA and previews of a new listing), asks for
 * exactly application/json: Rails and others treat an Accept that lists the any-type wildcard as a browser and
 * answer HTML. A text promise asks for its own type first, then any text, and never for the wildcard. An API that
 * only answers CSV usually ignores Accept, so QA without a promise still sees its CSV.
 */
export function acceptFor(ruleContentType: string | null | undefined): string {
  if (!ruleContentType || isJsonMediaType(ruleContentType)) return "application/json";
  return `${ruleContentType}, text/*;q=0.9`;
}

export function buildUpstreamRequest(
  api: UpstreamApi,
  op: Pick<OperationRow, "method" | "path">,
  input: Record<string, unknown>,
  ruleContentType?: string | null,
): { url: string; init: { method: string; headers: Record<string, string>; body?: string } } {
  const rest: Record<string, unknown> = { ...input };
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = rest[name];
    if (v === undefined || v === null) throw new Error(`missing path parameter ${name}`);
    // "." / ".." (also percent-encoded) or "" would let a buyer step outside the path prefix whose ownership
    // was verified, because URLs normalise dot segments. A "/" or a backslash is sent encoded (%2F, %5C), which the URL
    // check below can't see through, but some servers decode it before routing: "../../other" would then reach
    // another folder with the seller's key. One value fills one path segment, so neither is allowed (the same
    // rule as a proven path, @hirakumi/core ownership AMBIGUOUS_PATH).
    const raw = String(v);
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
    if (raw === "" || /^\.{1,2}$/.test(raw) || /^\.{1,2}$/.test(decoded) || /[/\\]/.test(raw) || /[/\\]/.test(decoded)) {
      throw new Error(`invalid path parameter ${name}`);
    }
    delete rest[name];
    return encodeURIComponent(String(v));
  });
  const prefix = api.path_prefix.replace(/\/+$/, "");
  const url = new URL(api.origin.replace(/\/+$/, "") + prefix + path);
  // Defence in depth (audit C1): URL parsing collapses dot segments and can even move the host, so check the
  // result, not the parts. Every upstream call (paid calls, escrow jobs, previews, QA, monitor) is built here.
  if (!urlWithinBase(url, api.origin, api.path_prefix)) {
    throw new Error(`blocked: the endpoint path ${op.path} resolves outside the API's folder (${prefix || "/"}) on ${new URL(api.origin).origin}`);
  }
  if (api.credentialError) throw new Error(`blocked: ${api.credentialError}`);
  const method = op.method.toUpperCase();
  // The hop header marks every call the gateway makes: if an origin ever routes back to the front door, the front
  // door answers 508 instead of calling itself again (frontDoor.ts).
  const headers: Record<string, string> = { accept: acceptFor(ruleContentType), "user-agent": "hirakumi-gateway/0.1", [HOP_HEADER]: "1" };
  // Shared input convention (P3 contract addition 3): `{name}` fields fill the path, a field named
  // `body` is the JSON request body, and every other field is a query parameter, for any method.
  const { body, ...query } = rest;
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
    else url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  // The seller's key last, so no buyer input can replace it. The URL was checked to be under the proven base above.
  const credential = api.credential;
  if (credential?.in === "header") headers[credential.name.toLowerCase()] = credential.value;
  if (credential?.in === "query") url.searchParams.set(credential.name, credential.value);
  if (body === undefined || method === "GET" || method === "HEAD") return { url: url.toString(), init: { method, headers } };
  headers["content-type"] = "application/json";
  return { url: url.toString(), init: { method, headers, body: JSON.stringify(body) } };
}

/** MIP-003 input_data arrives as an object (Sokosumi) or as [{key, value}] (MIP-003 examples). */
export function normalizeMip003Input(inputData: unknown): Record<string, unknown> | null {
  if (Array.isArray(inputData)) {
    const out: Record<string, unknown> = {};
    for (const item of inputData) {
      if (!item || typeof item !== "object" || typeof (item as { key?: unknown }).key !== "string") return null;
      // defineProperty, not out[key] = value: a key "__proto__" must be a field, never the object's prototype.
      Object.defineProperty(out, (item as { key: string }).key, { value: (item as { value?: unknown }).value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  if (inputData && typeof inputData === "object") return { ...(inputData as Record<string, unknown>) };
  return null;
}

/**
 * True when any string or key in a JSON value holds U+0000. Postgres jsonb refuses it ("unsupported Unicode escape
 * sequence"), so such an input can't be stored and must be refused before anything is created for it.
 */
export function containsNul(v: unknown): boolean {
  if (typeof v === "string") return v.includes("\u0000");
  if (Array.isArray(v)) return v.some(containsNul);
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => k.includes("\u0000") || containsNul(x));
  return false;
}

export type Execution = "upstream_ok" | "upstream_error" | "timeout" | "blocked";
export type OperationOutcome = {
  execution: Execution; verdict: "pass" | "fail" | "n/a"; reasons: string[]; result: UpstreamResult | null; latencyMs: number;
};

export async function runOperation(
  api: UpstreamApi,
  op: LoadedOp,
  input: Record<string, unknown>,
  opts: { timeoutMs: number; probe?: boolean },
): Promise<OperationOutcome> {
  const failVerdict = op.rule ? "fail" : "n/a";
  const outcome = await callUpstream(api, op, input, opts, failVerdict);
  if (!api.credential) return outcome;
  // An answer that repeats the seller's key is never passed on, and no reason may quote it.
  const reasons = outcome.reasons.map((r) => redactSecret(r, api.credential));
  if (outcome.result && (leaksSecret(outcome.result.body, api.credential) || leaksSecret(outcome.result.contentType, api.credential))) {
    return { ...outcome, execution: "upstream_error", verdict: failVerdict, reasons: ["the answer contained the API's key, so it was withheld"], result: null };
  }
  return { ...outcome, reasons };
}

async function callUpstream(
  api: UpstreamApi,
  op: LoadedOp,
  input: Record<string, unknown>,
  opts: { timeoutMs: number; probe?: boolean },
  failVerdict: "fail" | "n/a",
): Promise<OperationOutcome> {
  let req: ReturnType<typeof buildUpstreamRequest>;
  try {
    req = buildUpstreamRequest(api, op.row, input, op.rule?.contentType);
  } catch (e) {
    return { execution: "blocked", verdict: "n/a", reasons: [(e as Error).message], result: null, latencyMs: 0 };
  }
  if (opts.probe) req.init.headers["x-hirakumi-probe"] = "1";
  const started = performance.now();
  try {
    const result = await safeFetch(req.url, req.init, { timeoutMs: opts.timeoutMs });
    if (result.status >= 500) {
      return { execution: "upstream_error", verdict: failVerdict, reasons: [`upstream answered ${result.status}`], result, latencyMs: result.latencyMs };
    }
    if (!op.rule) return { execution: "upstream_ok", verdict: "n/a", reasons: [], result, latencyMs: result.latencyMs };
    const v = op.rule.check(result);
    return { execution: "upstream_ok", verdict: v.pass ? "pass" : "fail", reasons: v.reasons, result, latencyMs: result.latencyMs };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - started);
    if (e instanceof UpstreamBlockedError) return { execution: "blocked", verdict: "n/a", reasons: [e.message], result: null, latencyMs };
    if (e instanceof UpstreamTimeoutError) return { execution: "timeout", verdict: failVerdict, reasons: [e.message], result: null, latencyMs };
    return { execution: "upstream_error", verdict: failVerdict, reasons: [(e as Error).message], result: null, latencyMs };
  }
}
