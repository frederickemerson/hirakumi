import { urlWithinBase } from "./ownership";
import { isJsonMediaType } from "./rules";
import { upstreamSecretParts, type UpstreamAuth, type UpstreamCredential } from "./upstreamAuth";

/**
 * Sent on every upstream call. If an origin ever routes back to Hirakumi's front door, the front door answers 508
 * to a request carrying it instead of calling out again (apps/gateway frontDoor.ts). A reserved header.
 */
export const HOP_HEADER = "x-hirakumi-hop";

/**
 * The API as an upstream call needs it: its proven origin and path prefix, and optionally the seller's key (the
 * gateway opens it; the leak check calls without one). A single-key row opens to `credential`; a multi-part (hks3)
 * row opens to `auth` with `credential` null. credentialError is set when a stored key could not be opened.
 */
export type UpstreamTarget = {
  origin: string;
  path_prefix: string;
  credential?: UpstreamCredential | null;
  auth?: UpstreamAuth | null;
  credentialError?: string | null;
};

/**
 * The API's key, whichever way it was stored: a bag's parts and leak list, or the one credential with the parts
 * textLeaksSecret looks for (so a credential behaves exactly as before). Null when the API needs no key. Every read
 * of the key goes through here, so a bag (credential null) is never sent or checked any less than a credential.
 */
export function resolveAuth(api: Pick<UpstreamTarget, "credential" | "auth" | "credentialError">): UpstreamAuth | null {
  if (api.auth) return api.auth;
  return api.credential ? { parts: [api.credential], leakParts: upstreamSecretParts(api.credential.value) } : null;
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

/**
 * The request for one operation and one input. Every upstream call (paid calls, escrow jobs, previews, QA, monitor,
 * the leak check) is built here.
 */
export function buildUpstreamRequest(
  api: UpstreamTarget,
  op: { method: string; path: string },
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
    // rule as a proven path, ownership AMBIGUOUS_PATH).
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
  // result, not the parts.
  if (!urlWithinBase(url, api.origin, api.path_prefix)) {
    throw new Error(`blocked: the endpoint path ${op.path} resolves outside the API's folder (${prefix || "/"}) on ${new URL(api.origin).origin}`);
  }
  if (api.credentialError) throw new Error(`blocked: ${api.credentialError}`);
  const auth = resolveAuth(api);
  const method = op.method.toUpperCase();
  const headers: Record<string, string> = { accept: acceptFor(ruleContentType), "user-agent": "hirakumi-gateway/0.1", [HOP_HEADER]: "1" };
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
