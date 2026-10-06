"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { StepList } from "@/components/step-list";
import { PROGRESS_EVENT, progressKey, type ApiProgress } from "@/lib/progress";

export const POLL_MIN_MS = 1_000;
export const POLL_MAX_MS = 5_000;

/** 1 s while things move; each unchanged answer waits 1.5x longer, up to 5 s. */
export function nextDelay(prev: number, changed: boolean): number {
  return changed ? POLL_MIN_MS : Math.min(POLL_MAX_MS, Math.round(prev * 1.5));
}

/**
 * Keeps a waiting screen current by polling the small JSON progress endpoint instead of re-rendering
 * the whole page. Pauses while the tab is hidden, stops once the API is live, and when the state (or
 * a failure) changes it navigates inside a transition: to the new step's page, or a refresh of this one.
 */
export function useApiProgress(apiId: string, initial: ApiProgress): ApiProgress {
  const router = useRouter();
  const pathname = usePathname();
  const [progress, setProgress] = useState(initial);
  const [, startTransition] = useTransition();

  // A server refresh hands down a fresh snapshot.
  useEffect(() => setProgress(initial), [initial]);

  useEffect(() => {
    if (initial.settled) return;
    let delay = POLL_MIN_MS;
    let key = progressKey(initial);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let inFlight = false;

    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && !document.hidden) timer = setTimeout(tick, delay);
    };

    async function tick() {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/apis/${encodeURIComponent(apiId)}/progress`, { cache: "no-store", headers: { accept: "application/json" } });
        if (!res.ok) {
          delay = nextDelay(delay, false);
          return;
        }
        const next = (await res.json()) as ApiProgress;
        if (stopped) return;
        const nextKey = progressKey(next);
        const changed = nextKey !== key;
        key = nextKey;
        delay = nextDelay(delay, changed);
        if (changed) {
          setProgress(next);
          window.dispatchEvent(new CustomEvent<ApiProgress>(PROGRESS_EVENT, { detail: next }));
        }
        if (next.state !== initial.state || next.failure !== initial.failure) {
          stopped = true;
          startTransition(() => {
            if (next.href !== pathname) router.replace(next.href);
            else router.refresh();
          });
        } else if (next.settled) {
          stopped = true;
        }
      } catch {
        delay = nextDelay(delay, false);
      } finally {
        inFlight = false;
        schedule();
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
      } else {
        delay = POLL_MIN_MS;
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [apiId, initial, pathname, router]);

  return progress;
}

/** The listing timeline, kept live. */
export function LiveProgress({ apiId, initial }: { apiId: string; initial: ApiProgress }) {
  const progress = useApiProgress(apiId, initial);
  return <StepList timeline={progress.timeline} />;
}
