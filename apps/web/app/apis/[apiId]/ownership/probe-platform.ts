import { ownershipCheckUrl, safeFetchWithHeaders } from "@hirakumi/core";
import { detectPlatforms, type PlatformHint } from "@/lib/header-platform";

/** Short: the page streams while this runs, and the recipes work without it. */
const PROBE_TIMEOUT_MS = 5_000;
/** The gateway's ownership check sends the same one (apps/gateway/src/internal.ts), so a WAF treats both alike. */
const USER_AGENT = "hirakumi-gateway/0.1";

/**
 * One GET to the API's base URL, the same request the ownership check makes (same URL guard, SSRF-safe fetch,
 * headers only, redirects not followed), to read what the server says it runs on. Never throws: an API we can't
 * reach just gets no hint, and the panel shows every recipe.
 */
export async function probePlatform(api: { origin: string; pathPrefix: string }, code: string): Promise<PlatformHint[]> {
  const url = ownershipCheckUrl({ origin: api.origin, pathPrefix: api.pathPrefix, code });
  if (!url.ok) return [];
  try {
    const res = await safeFetchWithHeaders(url.url, { method: "GET", headers: { accept: "*/*", "user-agent": USER_AGENT } }, { timeoutMs: PROBE_TIMEOUT_MS });
    return detectPlatforms(res.headers);
  } catch {
    return [];
  }
}
