"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Pages opened from a Sokosumi comment for one wallet step (/act/<token>, /setup) show only that step: no header,
 * footer or help chat, nothing to navigate to. The seller signs and closes the tab.
 */
export function isFocusedPath(pathname: string | null): boolean {
  return !!pathname && (pathname.startsWith("/act/") || pathname === "/setup");
}

export function SiteChrome({ children }: { children: ReactNode }) {
  return isFocusedPath(usePathname()) ? null : <>{children}</>;
}
