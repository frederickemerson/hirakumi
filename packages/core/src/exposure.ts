import type { UpstreamResult } from "./fetch";
import type { CompiledRule } from "./rules";

/**
 * The leak check: what a stranger gets when they call the seller's API directly, without the seller's key.
 *
 * - "open": a good answer. It passes the endpoint's promise (the same check the gateway charges by), so anyone
 *   could get for free what buyers would pay Hirakumi for.
 * - "protected": a definite answer that is not a good one: 401, 402, 403 or 407, any other 4xx except 408 and 429,
 *   or a 2xx that fails the promise (a login page or an error sent with status 200).
 * - "unknown": no answer that settles it: a network error, a timeout, a blocked address, a redirect (never
 *   followed, so where it leads is not known), 408, 429 or a 5xx. Never counts as protected.
 */
export type Exposure = "open" | "protected" | "unknown";

/** Statuses that say the caller needs a key or must pay: the clearest sign of protection. */
export const PROTECTED_STATUSES: readonly number[] = [401, 402, 403, 407];
/** 4xx statuses that say nothing about access: try again later. */
const INCONCLUSIVE_4XX = new Set([408, 429]);

/**
 * One call made without the key. `result` is null when no answer arrived (network error, timeout, blocked address,
 * redirect). `rule` is the endpoint's promise, or null when it has none yet: any 2xx then counts as a good answer.
 */
export function classifyExposure(result: UpstreamResult | null, rule: Pick<CompiledRule, "check"> | null): Exposure {
  if (!result) return "unknown";
  const { status } = result;
  if (PROTECTED_STATUSES.includes(status)) return "protected";
  if (status >= 200 && status < 300) return !rule || rule.check(result).pass ? "open" : "protected";
  if (status >= 400 && status < 500) return INCONCLUSIVE_4XX.has(status) ? "unknown" : "protected";
  return "unknown";
}

/**
 * The API's exposure from its endpoints' results: open when any endpoint is open, protected only when every
 * endpoint is protected, else unknown (also when there is nothing to check).
 */
export function combineExposure(results: readonly Exposure[]): Exposure {
  if (results.includes("open")) return "open";
  if (results.length === 0 || results.includes("unknown")) return "unknown";
  return "protected";
}
