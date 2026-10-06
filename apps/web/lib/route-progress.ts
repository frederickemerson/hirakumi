/** Fired by code that navigates programmatically (router.push after a save) so the top bar starts. */
export const ROUTE_START_EVENT = "hirakumi:route-start";

export function startRouteProgress(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ROUTE_START_EVENT));
}

/** True for a left click without modifiers on a same-origin link that leads somewhere else. */
export function isInternalNavigation(e: MouseEvent, current: Location): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const target = e.target as Element | null;
  const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  let url: URL;
  try {
    url = new URL(anchor.href, current.href);
  } catch {
    return false;
  }
  if (url.origin !== current.origin) return false;
  // Same page with a hash only: the browser just scrolls.
  return url.pathname !== current.pathname || url.search !== current.search;
}
