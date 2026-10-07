"use client";

import { useEffect, useState } from "react";
import { Mascot } from "@/components/brand/mascot";
import { sellerTryHref, TryLiveLink } from "@/components/try-live-link";
import { buttonVariants } from "@/components/ui/button";
import type { Health } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Show the celebration only for an API that went live recently, once per browser. */
export const LIVE_MOMENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const seenKey = (apiId: string) => `hk-live-seen:${apiId}`;

export function shouldCelebrate(liveSince: string | null, seen: boolean, now = Date.now()): boolean {
  if (!liveSince || seen) return false;
  const t = new Date(liveSince).getTime();
  return Number.isFinite(t) && now - t >= 0 && now - t < LIVE_MOMENT_WINDOW_MS;
}

function readSeen(apiId: string): boolean {
  try {
    return window.localStorage.getItem(seenKey(apiId)) === "1";
  } catch {
    return false;
  }
}
function markSeen(apiId: string) {
  try {
    window.localStorage.setItem(seenKey(apiId), "1");
  } catch {
    // Private mode or blocked storage: the moment may show again, which is harmless.
  }
}

/**
 * The one-time "you're live" moment on the overview: Kumo, the registry token on Cardanoscan and a
 * way to try the API. `liveSince` is when the register step finished.
 */
export function LiveMoment({ apiId, liveSince, registryUrl, health = "healthy" }: {
  apiId: string;
  liveSince: string | null;
  registryUrl: string | null;
  health?: Health;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (shouldCelebrate(liveSince, readSeen(apiId))) {
      setShow(true);
      markSeen(apiId);
    }
  }, [apiId, liveSince]);
  if (!show) return null;

  return (
    <section
      aria-labelledby="live-moment-heading"
      className="relative overflow-hidden rounded-[2px] border-2 border-ink bg-ice p-6 shadow-hard sm:p-8"
    >
      <button
        type="button"
        onClick={() => setShow(false)}
        aria-label="Close"
        className="absolute top-2 right-2 flex size-10 items-center justify-center rounded-[2px] text-sub transition-colors duration-150 hover:bg-frost"
      >
        ×
      </button>
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <Mascot className="h-20 shrink-0 animate-pop" title="" />
        <div className="min-w-0 space-y-4">
          <h2 id="live-moment-heading" className="text-h-sm font-medium uppercase animate-rise [animation-delay:80ms]">
            Your API is live
          </h2>
          <p className="max-w-xl text-body-lg animate-rise [animation-delay:140ms]">
            It is registered on Masumi, and agents can buy call packs now. Each pack locks in escrow and pays you per answer that kept the promise.
          </p>
          <div className="flex flex-col gap-4 animate-rise [animation-delay:200ms] sm:flex-row sm:items-center">
            <TryLiveLink apiId={apiId} state="live" health={health} href={sellerTryHref(apiId)} />
            {registryUrl && (
              <a href={registryUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "link" }), "text-body")}>
                See the registry token on Cardanoscan
              </a>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
