"use client";

import { Elapsed } from "@/components/elapsed";
import { STEP_STATUS_LABEL } from "@/lib/copy";
import type { Timeline, TimelineItem } from "@/lib/timeline";
import type { OnboardStepStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const FILL: Record<OnboardStepStatus, string> = {
  done: "bg-sky",
  running: "stripes-sky",
  waiting_seller: "bg-canary",
  failed: "bg-coral",
  pending: "bg-frost",
};

const MARK: Record<OnboardStepStatus, string> = {
  done: "✓",
  running: "›",
  waiting_seller: "!",
  failed: "×",
  pending: "·",
};

function statusText(item: TimelineItem): string {
  if (item.status === "running" && item.progress) return `${item.progress.done} of ${item.progress.total} calls`;
  return STEP_STATUS_LABEL[item.status];
}

/**
 * The listing timeline: one fixed, ordered list of seven human steps, a progress bar of completed
 * steps out of the total, and live sub-progress for the test calls. Fills grow with transform only.
 */
export function StepList({ timeline }: { timeline: Timeline }) {
  const { items, done, total, pct, current } = timeline;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-4 text-caption font-semibold uppercase tracking-[0.04em]">
        <span>{`${done} of ${total} steps done`}</span>
        <span className="tabular-nums">{`${pct}%`}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Listing progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={current ? `${done} of ${total} done, now ${current.label.toLowerCase()}` : `${done} of ${total} done`}
        className="flex h-4 w-full overflow-hidden rounded-[2px] border-2 border-ink bg-frost"
      >
        {items.map((s) => (
          <span key={s.key} data-status={s.status} className="relative h-full flex-1 border-r border-ink last:border-r-0">
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 origin-left transition-transform duration-300 ease-[var(--ease-snap)] motion-reduce:transition-none",
                FILL[s.status],
                s.status === "pending" ? "scale-x-0" : "scale-x-100",
              )}
            />
          </span>
        ))}
      </div>
      <ol className="space-y-1.5 text-body">
        {items.map((s) => (
          <li key={s.key} data-status={s.status} className="space-y-1">
            <div className="flex items-baseline justify-between gap-4">
              <span className="flex items-baseline gap-2">
                <span
                  aria-hidden
                  className={cn("inline-block w-3 text-center font-semibold", s.status === "failed" && "text-coral", s.status === "pending" && "text-pencil")}
                >
                  {MARK[s.status]}
                </span>
                <span className={cn(s.status === "pending" && "text-graphite", (s.status === "running" || s.status === "waiting_seller") && "font-medium")}>
                  {s.label}
                </span>
              </span>
              <span className="shrink-0 text-right text-graphite tabular-nums">
                {statusText(s)}
                {s.status === "running" && <Elapsed since={s.since} prefix=" · " className="text-ink" />}
              </span>
            </div>
            {s.status === "running" && s.progress && (
              <div className="ml-5 h-1.5 overflow-hidden rounded-[2px] border border-ink bg-chalk" aria-hidden>
                <div
                  className="h-full w-full origin-left bg-sky transition-transform duration-300 ease-[var(--ease-snap)] motion-reduce:transition-none"
                  style={{ transform: `scaleX(${s.progress.done / s.progress.total})` }}
                />
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
