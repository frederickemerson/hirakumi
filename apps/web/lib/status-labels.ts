import type { HourState, StatusHour } from "./repo/status";
import type { ApiState, Health } from "./types";

/* Shared by the server status panel and the client hour bars, so it must not live in a "use client" module. */

export const HOUR_STATE_LABEL: Record<HourState, string> = { up: "Live", degraded: "Some checks failed", down: "Down", no_data: "No checks" };

export const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;

export function hourLabel(h: StatusHour): string {
  return `${hhmm(new Date(h.start))}: ${HOUR_STATE_LABEL[h.state]}${h.probes ? ` (${h.passed} of ${h.probes} checks passed)` : ""}`;
}

export type ApiStatusTone = "progress" | "failed" | "live" | "down" | "retired";

/**
 * The one status an API shows in lists (/apis and /account): Live or Down while live, Retired, Stopped when an
 * onboarding step failed, otherwise In progress. Pages may add where it stands as a detail line.
 */
export function apiStatus(state: ApiState, health: Health, stopped: boolean): { tone: ApiStatusTone; label: string } {
  if (state === "live") return health === "healthy" ? { tone: "live", label: "Live" } : { tone: "down", label: "Down" };
  if (state === "retired") return { tone: "retired", label: "Retired" };
  if (stopped) return { tone: "failed", label: "Stopped" };
  return { tone: "progress", label: "In progress" };
}

export const STATUS_BADGE_VARIANT: Record<ApiStatusTone, "sky" | "destructive" | "mint" | "secondary"> = {
  progress: "sky",
  failed: "destructive",
  live: "mint",
  down: "destructive",
  retired: "secondary",
};
