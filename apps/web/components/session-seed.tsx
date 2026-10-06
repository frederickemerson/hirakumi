"use client";

import { useLayoutEffect } from "react";
import { setAuth } from "@/lib/auth-client";

/**
 * Rendered by seller pages, which already read the session on the server. Hands the short address
 * to the header before the first paint after hydration, so it never waits on /api/auth/me there.
 */
export function SessionSeed({ address }: { address: string }) {
  useLayoutEffect(() => {
    setAuth({ status: "in", address });
  }, [address]);
  return null;
}
