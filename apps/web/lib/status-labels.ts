import type { HourState, StatusHour } from "./repo/status";

/* Shared by the server status panel and the client hour bars, so it must not live in a "use client" module. */

export const HOUR_STATE_LABEL: Record<HourState, string> = { up: "Live", degraded: "Some checks failed", down: "Down", no_data: "No checks" };

export const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;

export function hourLabel(h: StatusHour): string {
  return `${hhmm(new Date(h.start))}: ${HOUR_STATE_LABEL[h.state]}${h.probes ? ` (${h.passed} of ${h.probes} checks passed)` : ""}`;
}
