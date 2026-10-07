import { getSql } from "./db";
import { env } from "./env";
import { liveSession } from "./repo/sessions";
import { readCookie, SESSION_COOKIE, type SessionInfo } from "./session";

export type ApiRouteContext = { params: Promise<{ apiId: string }> };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

export function errorJson(status: number, message: string): Response {
  return json({ error: message }, status);
}

const MAX_BODY_BYTES = 64 * 1024;

/** JSON bodies only. Requiring application/json also blocks cross-site form posts (CSRF). */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  // Compare the media type exactly: "text/plain; application/json" is a CORS-simple type a cross-site form can send.
  const mediaType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return null;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF guard for state-changing requests. Body-less POSTs (publish, retire, logout) never reach
 * readJson's content-type check, so we also refuse requests a browser marks as cross-site.
 * Browsers send Sec-Fetch-Site; older ones only Origin, which must match WEB_BASE_URL.
 * Requests with neither header (curl, server-to-server) carry no ambient browser intent and pass.
 */
export function sameOrigin(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(env.webBaseUrl()).origin;
  } catch {
    return false; // "null" or malformed Origin, or no WEB_BASE_URL configured: refuse
  }
}

/** The signed-in seller, or the response to send. A session that can't be checked is refused (503), never trusted. */
export async function requireSeller(req: Request): Promise<SessionInfo | Response> {
  if (!sameOrigin(req)) return errorJson(403, "Cross-site request refused.");
  let session: SessionInfo | null;
  try {
    session = await liveSession(getSql(), readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  } catch (e) {
    console.error("session check unavailable", e instanceof Error ? e.message : e);
    return errorJson(503, SESSION_UNAVAILABLE);
  }
  return session ?? errorJson(401, "Please sign in with your wallet again.");
}

export const SESSION_UNAVAILABLE = "Hirakumi is busy, try again shortly.";
