import { stepForState, type Step } from "./flow";
import type { Timeline } from "./timeline";
import type { Api, ApiState } from "./types";

/* Client-safe: no database imports here (see lib/repo/progress.ts for the loader). */

/** What a waiting screen needs to update itself: small, JSON-safe, and the same on server and client. */
export type ApiProgress = {
  state: ApiState;
  step: Step;
  /** The page the seller should be on for this state. */
  href: string;
  timeline: Timeline;
  failure: string | null;
  /** True once the API no longer moves by itself (live or retired): pollers stop. */
  settled: boolean;
};

export function progressFor(api: Pick<Api, "id" | "state">, timeline: Timeline, failure: string | null): ApiProgress {
  const step = stepForState(api.state);
  return {
    state: api.state,
    step,
    href: `/apis/${api.id}/${step}`,
    timeline,
    failure,
    settled: api.state === "live" || api.state === "retired",
  };
}

/**
 * Fired on window by the waiting-screen poller (components/live-progress.tsx) with the new ApiProgress
 * as detail, so the guide panel follows along without polling a second time.
 */
export const PROGRESS_EVENT = "hirakumi:progress";

/** A cheap fingerprint of everything a poller reacts to. */
export function progressKey(p: ApiProgress): string {
  return JSON.stringify([p.state, p.failure, p.timeline.items.map((i) => [i.status, i.progress?.done ?? null])]);
}
