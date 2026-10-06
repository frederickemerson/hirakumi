import type { ApiState } from "./types";

/* Client-safe: the account page and the DELETE route share this one rule. */

/** What decides how an API is deleted. All of it comes from the database, read under a row lock. */
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
 * Every API can be deleted. Null when it never reached the Masumi registry and nobody paid for it: its rows
 * are erased. Otherwise the reason its rows stay (the registry entry, receipts and escrow channels point at
 * them), in words the seller can read: it is taken off the market and hidden from the account instead.
 */
export function recordsKeptReason(f: DeleteFacts): string | null {
  if (REACHED_REGISTRY.has(f.state) || f.agentIdentifier || f.registerStarted) {
    return "It reached the Masumi registry, so we keep its records.";
  }
  if (f.sold) return "Buyers paid for it, so we keep their receipts.";
  return null;
}
