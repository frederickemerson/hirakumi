"use client";

import { useEffect, useState } from "react";

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Seconds elapsed since `since` (or since mount), ticking once a second. Null before hydration. */
export function useElapsed(since?: Date | string | number | null, active = true): number | null {
  const [now, setNow] = useState<number | null>(null);
  const [mountedAt] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (now === null) return null;
  const start = since == null ? mountedAt : new Date(since).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((now - start) / 1000));
}

/**
 * "checking your API… 12s": a live elapsed-time hint next to a long-running step.
 * Renders nothing until hydrated so the server and client markup agree.
 */
export function Elapsed({ since, prefix, className }: { since?: Date | string | number | null; prefix?: string; className?: string }) {
  const seconds = useElapsed(since);
  if (seconds === null) return null;
  return (
    <span className={className} aria-live="off">
      {prefix}
      <span className="tabular-nums">{formatElapsed(seconds)}</span>
    </span>
  );
}
