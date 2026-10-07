import {
  isJsonMediaType, KEY_FORBIDDEN_TEXT, KEY_REFUSED_TEXT, KEY_UNSCANNABLE_TEXT, redactUpstreamParts, redactUpstreamSecret, safeFetch, textLeaksAny,
  textLeaksSecret, upstreamSecretForms, upstreamSecretParts, urlWithinBase, UpstreamBlockedError, UpstreamTimeoutError, type UpstreamAuth,
  type UpstreamCredential, type UpstreamResult,
} from "@hirakumi/core";
import type { ApiRow, OperationRow } from "@hirakumi/db";
import type { LoadedOp, UpstreamAccess } from "./registry";

/** The API as an upstream call needs it. Access is optional: an API without it needs no key. */
export type UpstreamApi = Pick<ApiRow, "origin" | "path_prefix"> & Partial<UpstreamAccess>;

/**
 * The API's key, whichever way it was stored: a bag's parts and leak list, or the one credential with the parts
 * textLeaksSecret looks for (so a credential behaves exactly as before). Null when the API needs no key. Every read
 * of the key goes through here, so a bag (credential null) is never sent or checked any less than a credential.
 */
export function resolveAuth(api: Partial<UpstreamAccess>): UpstreamAuth | null {
  if (api.auth) return api.auth;
  return api.credential ? { parts: [api.credential], leakParts: upstreamSecretParts(api.credential.value) } : null;
}

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
  const auth = resolveAuth(api);
  const method = op.method.toUpperCase();
  const headers: Record<string, string> = { accept: acceptFor(ruleContentType), "user-agent": "hirakumi-gateway/0.1" };
  // A compressed answer can't be checked for the key (bodies are never decompressed), so a keyed call asks for none.
  if (auth) headers["accept-encoding"] = "identity";
  // Shared input convention (P3 contract addition 3): `{name}` fields fill the path, a field named
  // `body` is the JSON request body, and every other field is a query parameter, for any method.
  const { body, ...query } = rest;
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
    else url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  // The seller's key last, so no buyer input can replace it. The URL was checked to be under the proven base above.
  for (const part of auth?.parts ?? []) {
    if (part.in === "header") headers[part.name.toLowerCase()] = part.value;
    else url.searchParams.set(part.name, part.value);
  }
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
/**
 * What one upstream call came to. `auth` is set when a keyed call was answered 401 (refused) or 403 (forbidden), and
 * its reasons then start with the key reason. `retryAfter` is the answer's Retry-After in seconds, when it parses.
 */
export type OperationOutcome = {
  execution: Execution; verdict: "pass" | "fail" | "n/a"; reasons: string[]; result: UpstreamResult | null; latencyMs: number;
  auth?: "refused" | "forbidden"; retryAfter?: number;
};

/** The reason given when an answer was withheld because it repeated a secret part of the API's key. */
export const KEY_WITHHELD_TEXT = "the answer contained the API's key, so it was withheld";

const KEY_STATUS: Record<number, { auth: "refused" | "forbidden"; reason: string }> = {
  401: { auth: "refused", reason: KEY_REFUSED_TEXT },
  403: { auth: "forbidden", reason: KEY_FORBIDDEN_TEXT },
};

/**
 * Calls the API and, when it needs a key, never passes on an answer that repeats any secret part or that came
 * compressed (it could not be checked), and redacts the key from every reason. A keyed call answered 401 or 403
 * leads with a reason saying the key was refused, which the monitor turns into the seller's Down message.
 */
export async function runOperation(
  api: UpstreamApi,
  op: LoadedOp,
  input: Record<string, unknown>,
  opts: { timeoutMs: number; probe?: boolean },
): Promise<OperationOutcome> {
  const failVerdict = op.rule ? "fail" : "n/a";
  const outcome = await callUpstream(api, op, input, opts, failVerdict);
  const auth = resolveAuth(api);
  if (!auth) return outcome;
  // An answer that repeats the seller's key is never passed on, and no reason may quote it.
  const reasons = outcome.reasons.map((r) => redactUpstreamParts(r, auth.leakParts));
  const result = outcome.result;
  if (!result) return { ...outcome, reasons };
  if (result.contentEncoding && result.contentEncoding !== "identity") {
    return { ...outcome, execution: "upstream_error", verdict: failVerdict, reasons: [KEY_UNSCANNABLE_TEXT], result: null };
  }
  if (textLeaksAny(result.body, auth.leakParts) || textLeaksAny(result.contentType, auth.leakParts)) {
    return { ...outcome, execution: "upstream_error", verdict: failVerdict, reasons: [KEY_WITHHELD_TEXT], result: null };
  }
  const key = outcome.verdict === "pass" ? undefined : KEY_STATUS[result.status];
  if (key) return { ...outcome, reasons: [key.reason, ...reasons], auth: key.auth };
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
    const outcome = judge(result, op, failVerdict);
    return result.retryAfter === undefined ? outcome : { ...outcome, retryAfter: result.retryAfter };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - started);
    if (e instanceof UpstreamBlockedError) return { execution: "blocked", verdict: "n/a", reasons: [e.message], result: null, latencyMs };
    if (e instanceof UpstreamTimeoutError) return { execution: "timeout", verdict: failVerdict, reasons: [e.message], result: null, latencyMs };
    return { execution: "upstream_error", verdict: failVerdict, reasons: [(e as Error).message], result: null, latencyMs };
  }
}

/** The verdict on an answer: a 5xx is an upstream error, otherwise the operation's rule decides (none: n/a). */
function judge(result: UpstreamResult, op: LoadedOp, failVerdict: "fail" | "n/a"): OperationOutcome {
  if (result.status >= 500) {
    return { execution: "upstream_error", verdict: failVerdict, reasons: [`upstream answered ${result.status}`], result, latencyMs: result.latencyMs };
  }
  if (!op.rule) return { execution: "upstream_ok", verdict: "n/a", reasons: [], result, latencyMs: result.latencyMs };
  const v = op.rule.check(result);
  return { execution: "upstream_ok", verdict: v.pass ? "pass" : "fail", reasons: v.reasons, result, latencyMs: result.latencyMs };
}
