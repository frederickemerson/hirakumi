"use client";

import { Elapsed } from "@/components/elapsed";
import { humanizeStep, STEP_STATUS_LABEL } from "@/lib/copy";
import type { OnboardStep, OnboardStepStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const SEGMENT: Record<OnboardStepStatus, string> = {
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

/** The onboarding steps as a real progress bar (done / total) with the current step striped and timed. */
export function StepList({ steps }: { steps: OnboardStep[] }) {
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.status === "done").length;
  const pct = Math.round((done / steps.length) * 100);
  const current = steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "waiting_seller");

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-4 text-caption font-semibold uppercase tracking-[0.04em]">
        <span>{`${done} of ${steps.length} steps done`}</span>
        <span className="tabular-nums">{`${pct}%`}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Listing progress"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-valuetext={current ? `${done} of ${steps.length} done, now ${humanizeStep(current.step).toLowerCase()}` : `${done} of ${steps.length} done`}
        className="flex h-4 w-full overflow-hidden rounded-[2px] border-2 border-ink bg-frost"
      >
        {steps.map((s) => (
          <span key={s.step} data-status={s.status} className={cn("h-full flex-1 border-r border-ink last:border-r-0", SEGMENT[s.status])} />
        ))}
      </div>
      <ul className="space-y-1 text-body">
        {steps.map((s) => (
          <li key={s.step} data-status={s.status} className="flex items-baseline justify-between gap-4">
            <span className="flex items-baseline gap-2">
              <span aria-hidden className={cn("inline-block w-3 text-center font-semibold", s.status === "failed" && "text-coral", s.status === "pending" && "text-pencil")}>
                {MARK[s.status]}
              </span>
              <span className={cn(s.status === "pending" && "text-graphite", s.status === "running" && "font-medium")}>{humanizeStep(s.step)}</span>
            </span>
            <span className="shrink-0 text-right text-graphite">
              {STEP_STATUS_LABEL[s.status]}
              {s.status === "running" && <Elapsed since={s.updatedAt} prefix=" · " className="text-ink" />}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
