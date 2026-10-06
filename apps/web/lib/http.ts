import { readCookie, readSessionToken, SESSION_COOKIE, type SessionInfo } from "./session";

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
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return null;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function requireSeller(req: Request): SessionInfo | Response {
  const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  const session = token ? readSessionToken(token) : null;
  return session ?? errorJson(401, "Please sign in with your wallet again.");
}
