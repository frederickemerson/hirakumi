import type { ApiState } from "./types";

/* Client-safe: the account page and the DELETE route share this one rule. */

/** What decides whether an API may be deleted. All of it comes from the database, read under a row lock. */
export type DeleteFacts = {
  state: ApiState;
  agentIdentifier: string | null;
  /** The coworker started (or finished) the register step: Masumi may know this API. */
  registerStarted: boolean;
  /** A buyer paid for a pack or a job: the records are someone else's receipt. */
  sold: boolean;
};

const REACHED_REGISTRY: ReadonlySet<ApiState> = new Set(["registering", "live", "retired"]);

/**
 * Null when the API never reached the Masumi registry and nobody paid for it. Otherwise the reason,
 * in words the seller can act on. A live API is retired instead; one that reached the registry keeps
 * its records because the registry entry and any receipts point at them.
 */
export function deleteBlocker(f: DeleteFacts): string | null {
  if (f.state === "live") return "This API is on the Masumi registry. Retire it instead.";
  if (REACHED_REGISTRY.has(f.state) || f.agentIdentifier || f.registerStarted) {
    return "This API reached the Masumi registry, so its records stay.";
  }
  if (f.sold) return "Buyers paid for this API, so its records stay.";
  return null;
}
