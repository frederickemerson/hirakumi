import {
  matchVerifyHeader, ownershipCheckUrl, safeFetchWithHeaders, UpstreamBlockedError, UpstreamTimeoutError,
  UpstreamTooLargeError, VERIFY_HEADER, type UpstreamProbe,
} from "@hirakumi/core";

export type OwnershipReason =
  | "verified" | "no_code" | "bad_url" | "blocked" | "timeout" | "unreachable" | "too_large" | "missing" | "mismatch";
export type OwnershipCheck = { ok: boolean; reason: OwnershipReason; triedUrl: string; detail: string; status?: number };

const OWNERSHIP_TIMEOUT_MS = 10_000;
/** Fixed, like every gateway call (upstream.ts): a request with no User-Agent is often stopped by a WAF before it reaches the seller's code. */
const OWNERSHIP_USER_AGENT = "hirakumi-gateway/0.1";

/**
 * One plain GET to the API's base URL: no query, no body, nothing the seller wrote, redirects not followed, through
 * the SSRF-safe fetch. The header counts on any status, since only someone who controls the answers under the base
 * can add it. Only the status and headers are read, so a large or streaming page at the base still passes. Used by
 * the proof step (internal.ts) and by the monitor's re-check, so both send the same request.
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

