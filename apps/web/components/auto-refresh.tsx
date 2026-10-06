"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-runs the server component every `everyMs` so waiting screens update by themselves. */
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
