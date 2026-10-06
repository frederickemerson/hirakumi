"use client";

import { useState } from "react";
import type { HourState, StatusHour } from "@/lib/repo/status";
import { cn } from "@/lib/utils";

export const HOUR_STATE_LABEL: Record<HourState, string> = { up: "Live", degraded: "Some checks failed", down: "Down", no_data: "No checks" };
const STATE_CLASS: Record<HourState, string> = {
  up: "bg-sky",
  degraded: "bg-canary",
  down: "bg-coral",
  no_data: "bg-chalk",
};

export const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;

export function hourLabel(h: StatusHour): string {
  return `${hhmm(new Date(h.start))}: ${HOUR_STATE_LABEL[h.state]}${h.probes ? ` (${h.passed} of ${h.probes} checks passed)` : ""}`;
}

/**
 * 24 hourly health bars. Hover shows a tooltip on desktop; on a phone, tapping a bar writes its label
 * underneath (hover doesn't exist there). The newest hour is selected to start.
 */
export function HourBars({ hours }: { hours: StatusHour[] }) {
  const [selected, setSelected] = useState(hours.length - 1);
  const current = hours[selected];
  return (
    <div className="space-y-2">
      <ol className="flex h-10 items-stretch gap-0.5" aria-label="Hourly health, oldest first">
        {hours.map((h, i) => {
          const label = hourLabel(h);
          return (
            <li key={new Date(h.start).toISOString()} className="flex flex-1">
              <button
                type="button"
                aria-label={label}
                aria-pressed={i === selected}
                title={label}
                onClick={() => setSelected(i)}
                className={cn(
                  "flex-1 cursor-pointer rounded-[2px] border border-ink transition-transform duration-100 ease-[var(--ease-press)] active:scale-y-90 motion-reduce:transition-none",
                  STATE_CLASS[h.state],
                  i === selected && "outline-2 outline-offset-1 outline-ink",
                )}
              />
            </li>
          );
        })}
      </ol>
      {current && (
        <p aria-live="polite" className="text-caption tabular-nums">
          {hourLabel(current)}
        </p>
      )}
    </div>
  );
}
