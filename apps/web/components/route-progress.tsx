"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isInternalNavigation, ROUTE_START_EVENT } from "@/lib/route-progress";

type Phase = "idle" | "loading" | "done";

/**
 * A 3px sky bar along the top edge while a route change is in flight. It starts on any internal
 * link click (or startRouteProgress()) and completes when the pathname changes.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>("idle");
  const started = useRef(false);

  useEffect(() => {
    function start() {
      started.current = true;
      setPhase("loading");
    }
    function onClick(e: MouseEvent) {
      if (isInternalNavigation(e, window.location)) start();
    }
    document.addEventListener("click", onClick, true);
    window.addEventListener(ROUTE_START_EVENT, start);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(ROUTE_START_EVENT, start);
    };
  }, []);

  // The route changed: fill the bar, then let it fade.
  useEffect(() => {
    if (!started.current) return;
    started.current = false;
    setPhase("done");
    const t = setTimeout(() => setPhase("idle"), 450);
    return () => clearTimeout(t);
  }, [pathname]);

  // Never strand the bar if a navigation is cancelled.
  useEffect(() => {
    if (phase !== "loading") return;
    const t = setTimeout(() => {
      started.current = false;
      setPhase("idle");
    }, 12_000);
    return () => clearTimeout(t);
  }, [phase]);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[3px]">
      <div
        data-phase={phase}
        className={
          "h-full origin-left bg-sky " +
          (phase === "loading"
            ? "motion-safe:[animation:trickle_6s_cubic-bezier(0.1,0.7,0.2,1)_forwards] motion-reduce:scale-x-90"
            : phase === "done"
              ? "scale-x-100 transition-transform duration-200"
              : "scale-x-0 opacity-0 transition-opacity duration-300")
        }
      />
    </div>
  );
}
