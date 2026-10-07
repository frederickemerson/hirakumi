import { Resolver } from "node:dns/promises";
import {
  isNoRecordError, matchVerifyHeader, matchVerifyTxt, ownershipCheckUrl, safeFetchWithHeaders, UpstreamBlockedError,
  UpstreamTimeoutError, UpstreamTooLargeError, VERIFY_HEADER, verifyRecordFor, type TxtLookup, type UpstreamProbe,
} from "@hirakumi/core";

export type DnsReason = "verified" | "no_code" | "bad_host" | "timeout" | "unreachable" | "missing" | "mismatch";
/** The DNS proof's answer. `record` is the TXT name looked up (`_hirakumi.<host>`). */
export type DnsCheck = { ok: boolean; reason: DnsReason; record: string; detail: string };

/** Public resolvers by default: the answer the seller's DNS gives now, not one the gateway's host cached earlier. */
export const DEFAULT_DNS_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

/** TXT lookups through these resolvers, 3 s per try, 2 tries per server. */
export function txtLookupVia(servers: readonly string[]): TxtLookup {
  const resolver = new Resolver({ timeout: 3_000, tries: 2 });
  if (servers.length) resolver.setServers([...servers]);
  return (name) => resolver.resolveTxt(name);
}

/**
 * The ownership proof: one TXT lookup of `_hirakumi.<host>`, looking for this API's code. No request reaches the
 * seller's API. Used by the proof step (internal.ts) and the monitor's re-check, so both ask the same question.
 */
export async function probeVerifyDns(origin: string, token: string | null, lookup: TxtLookup): Promise<DnsCheck> {
  const rec = verifyRecordFor(origin);
  const record = rec.ok ? rec.name : rec.host;
  const fail = (reason: DnsReason, detail: string): DnsCheck => ({ ok: false, reason, record, detail });
  if (token === null) return fail("no_code", "This API has no verification code yet. Open the ownership page to get one.");
  if (!rec.ok) return fail("bad_host", rec.detail);
  let records: string[][];
  try {
    records = await lookup(rec.name);
  } catch (e) {
    if (isNoRecordError(e)) records = [];
    else if ((e as { code?: unknown }).code === "ETIMEOUT") return fail("timeout", `DNS did not answer for ${rec.name} in time.`);
    else return fail("unreachable", `Could not look up ${rec.name}: ${(e as { code?: string }).code ?? (e as Error).message}.`);
  }
  const match = matchVerifyTxt(records, token);
  if (match === "missing") return fail("missing", `No TXT record found at ${rec.name} yet.`);
  if (match === "mismatch") return fail("mismatch", `Found a TXT record at ${rec.name}, but not with this API's code.`);
  return { ok: true, reason: "verified", record: rec.name, detail: `Found your code in the TXT record at ${rec.name}.` };
}

export type OwnershipReason =
  | "verified" | "no_code" | "bad_url" | "blocked" | "timeout" | "unreachable" | "too_large" | "missing" | "mismatch";
/** The legacy header proof's answer. */
export type OwnershipCheck = { ok: boolean; reason: OwnershipReason; triedUrl: string; detail: string; status?: number };

const OWNERSHIP_TIMEOUT_MS = 10_000;
/** Fixed, like every gateway call (upstream.ts): a request with no User-Agent is often stopped by a WAF before it reaches the seller's code. */
const OWNERSHIP_USER_AGENT = "hirakumi-gateway/0.1";

/**
 * Legacy: APIs proven before the DNS proof sent their code in the X-Hirakumi-Verify response header. New proofs
 * never use it; the monitor's re-check still does for those APIs (kind 'header'), so they stay on sale.
 * One plain GET to the API's base URL: no query, no body, nothing the seller wrote, redirects not followed, through
 * the SSRF-safe fetch. The header counts on any status, since only someone who controls the answers under the base
 * can add it. Only the status and headers are read, so a large or streaming page at the base still passes.
 */
export async function probeVerifyHeader(
  target: { origin: string; path_prefix: string }, token: string | null, upstreamTimeoutMs: number,
): Promise<OwnershipCheck> {
  // The code first: the URL guard refuses a base URL that carries it.
  const code = token === null ? null : { token };
  const checkUrl = ownershipCheckUrl({ origin: target.origin, pathPrefix: target.path_prefix, code: code?.token ?? "" });
  const triedUrl = checkUrl.url;
  const fail = (reason: OwnershipReason, detail: string, status?: number): OwnershipCheck =>
    ({ ok: false, reason, triedUrl, detail, ...(status === undefined ? {} : { status }) });
  if (!code) return fail("no_code", "This API has no verification code yet. Open the ownership page to get one.");
  if (!checkUrl.ok) return fail("bad_url", checkUrl.detail);
  const timeoutMs = Math.min(OWNERSHIP_TIMEOUT_MS, upstreamTimeoutMs);
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

