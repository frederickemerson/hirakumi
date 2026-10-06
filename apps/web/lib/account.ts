import type { Timeline } from "./timeline";
import type { ApiState, Health } from "./types";

/* Client-safe: the account page's data shapes and the numbers derived from them. */

export type ApiBadge = {
  tone: "progress" | "failed" | "live" | "down" | "retired";
  label: string;
  /** Where the API stands, in a few words ("Step 3 of 7: Choose endpoints"). */
  detail: string | null;
};

export type AccountApi = {
  id: string;
  name: string;
  state: ApiState;
  health: Health;
  healthCheckedAt: string | null;
  createdAt: string;
  /** Paid calls (packs and jobs) in the last 24 hours, and how many kept or broke the promise. */
  paidCallsDay: number;
  passDay: number;
  failDay: number;
  /** tUSDM micros received from settled packs plus completed jobs after Masumi's fee. */
  receivedMicros: string;
  badge: ApiBadge;
  /** Null when the seller may delete this API; otherwise why not. */
  deleteBlocker: string | null;
};

export type Account = {
  address: string;
  createdAt: string;
  sokosumiUserId: string | null;
  apis: AccountApi[];
};

export type AccountTotals = { live: number; paidCallsDay: number; receivedMicros: string };

/** Share of decided paid calls that kept the promise, as on the overview page; null before any. */
export function passRatePct(a: Pick<AccountApi, "passDay" | "failDay">): number | null {
  const decided = a.passDay + a.failDay;
  return decided === 0 ? null : Math.round((a.passDay / decided) * 100);
}

/** Totals across APIs. Pure, so the page recomputes them at once when a row is retired or deleted. */
export function accountTotals(apis: AccountApi[]): AccountTotals {
  return {
    live: apis.filter((a) => a.state === "live").length,
    paidCallsDay: apis.reduce((n, a) => n + a.paidCallsDay, 0),
    receivedMicros: apis.reduce((n, a) => n + BigInt(a.receivedMicros), 0n).toString(),
  };
}

export function apiBadge(state: ApiState, health: Health, timeline: Timeline): ApiBadge {
  if (state === "live") return health === "healthy" ? { tone: "live", label: "Live", detail: null } : { tone: "down", label: "Down", detail: null };
  if (state === "retired") return { tone: "retired", label: "Retired", detail: null };
  const current = timeline.current;
  const index = current ? timeline.items.indexOf(current) + 1 : timeline.done + 1;
  const where = `Step ${Math.min(index, timeline.total)} of ${timeline.total}${current ? `: ${current.label}` : ""}`;
  if (current?.status === "failed") return { tone: "failed", label: "Stopped", detail: `${where}. It failed.` };
  if (current?.status === "waiting_seller") return { tone: "progress", label: "In progress", detail: `${where}. Your turn.` };
  return { tone: "progress", label: "In progress", detail: where };
}
