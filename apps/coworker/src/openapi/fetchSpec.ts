import { safeFetch, UpstreamBlockedError, type UpstreamResult } from "@hirakumi/core";
import { PermanentError } from "../errors.js";

export type SafeFetch = typeof safeFetch;
export const SPEC_MAX_BYTES = 1_000_000;

/** Fetches the seller's OpenAPI document through the SSRF-safe fetch from @hirakumi/core. */
export function createSpecFetcher(fetchImpl: SafeFetch = safeFetch): (url: string) => Promise<string> {
  return async (url) => {
    let res: UpstreamResult;
    try {
      res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json, application/yaml, text/yaml" } }, { timeoutMs: 15_000, maxBytes: SPEC_MAX_BYTES });
    } catch (e) {
      if (e instanceof UpstreamBlockedError) {
        throw new PermanentError(`We can't fetch ${url}: it must be a public HTTPS address with no redirects (${e.message}).`);
      }
      throw e;
    }
    if (res.status !== 200) {
      throw new PermanentError(`Fetching your OpenAPI file at ${url} returned HTTP ${res.status}. Check the link and try again.`);
    }
    return res.body;
  };
}
