import { STATE_LABEL } from "./copy";
import type { HourState, StatusHour } from "./repo/status";
import type { ApiState, Health } from "./types";

/* Shared by the server status panel and the client hour bars, so it must not live in a "use client" module. */

const HOUR_STATE_LABEL: Record<HourState, string> = { up: "Live", degraded: "Some checks failed", down: "Down", no_data: "No checks" };

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

export type StatusLightColor = "mint" | "coral" | "pencil" | "sky";

/**
 * The round light before an API's name in the seller's lists: its colour, the short label shown on hover and focus
 * (and read by screen readers), and whether it pulses (only while live and healthy). Built on the tone apiStatus
 * derived from state, health and the onboarding timeline; `state` names the setup step.
 */
export function statusLight(tone: ApiStatusTone, state: ApiState): { color: StatusLightColor; label: string; pulse: boolean } {
  switch (tone) {
    case "live": return { color: "mint", label: "Running", pulse: true };
    case "down": return { color: "coral", label: "Down", pulse: false };
    case "failed": return { color: "pencil", label: "Stopped", pulse: false };
    case "retired": return { color: "pencil", label: "Retired", pulse: false };
    case "progress": return { color: "sky", label: `Setting up: ${STATE_LABEL[state]}`, pulse: false };
  }
}

