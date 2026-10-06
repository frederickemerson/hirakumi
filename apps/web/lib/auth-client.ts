import { useEffect, useSyncExternalStore } from "react";

/**
 * The signed-in state the header and the "List your API" links show. The session cookie is HttpOnly
 * and the landing page is static, so this lives on the client: seeded by seller pages (which already
 * know the session), set by login and logout, and otherwise probed once from /api/auth/me.
 */
export type Auth = { status: "unknown" } | { status: "out" } | { status: "in"; address: string };

const UNKNOWN: Auth = { status: "unknown" };

let current: Auth = UNKNOWN;
// Bumped on every write so a probe that started before a login or logout can't overwrite it.
let version = 0;
let probing: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function getAuth(): Auth {
  return current;
}

export function setAuth(next: Auth): void {
  version++;
  if (next.status === current.status && (next.status !== "in" || (current.status === "in" && next.address === current.address))) return;
  current = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Asks the server once; concurrent callers share the request. A failed probe settles on signed out: the header
 * must show something, and a seller whose session can't be read can't use it on this page either.
 */
export function probeAuth(): Promise<void> {
  if (probing) return probing;
  const started = version;
  probing = (async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) {
        if (version === started) setAuth({ status: "out" });
        return;
      }
      const data = (await res.json()) as { signedIn?: boolean; address?: string };
      if (version !== started) return;
      setAuth(data.signedIn && typeof data.address === "string" ? { status: "in", address: data.address } : { status: "out" });
    } catch {
      // Offline or blocked: show the signed-out buttons rather than an empty header.
      if (version === started) setAuth({ status: "out" });
    } finally {
      probing = null;
    }
  })();
  return probing;
}

/** The current state. The server render and first client render are always "unknown" (the header shows neither state), so hydration matches. */
export function useAuth(): Auth {
  const auth = useSyncExternalStore(subscribe, getAuth, () => UNKNOWN);
  useEffect(() => {
    if (getAuth().status === "unknown") void probeAuth();
  }, []);
  return auth;
}

/**
 * Clears the session with the same-origin POST the logout route's CSRF guard expects. The route
 * answers with a redirect for plain form posts; here we stop at it instead of fetching the login page.
 */
export async function logOut(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", redirect: "manual" });
    if (res.type !== "opaqueredirect" && (res.status < 200 || res.status >= 400)) return false;
  } catch {
    return false;
  }
  setAuth({ status: "out" });
  return true;
}

export function resetAuthForTests(): void {
  current = UNKNOWN;
  version++;
  probing = null;
  listeners.forEach((l) => l());
}
