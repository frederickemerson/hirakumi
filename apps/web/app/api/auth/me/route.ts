import { shortAddress } from "@/lib/copy";
import { getSql } from "@/lib/db";
import { errorJson, json, SESSION_UNAVAILABLE } from "@/lib/http";
import { liveSession } from "@/lib/repo/sessions";
import { readCookie, SESSION_COOKIE, type SessionInfo } from "@/lib/session";

/**
 * Who is signed in, for the header's client island. The session cookie is HttpOnly, so the static
 * pages ask here instead of reading it. Only the short address leaves the server, never the seller id.
 */
export async function GET(req: Request): Promise<Response> {
  let session: SessionInfo | null;
  try {
    session = await liveSession(getSql(), readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  } catch (e) {
    console.error("me: session check unavailable", e instanceof Error ? e.message : e);
    return errorJson(503, SESSION_UNAVAILABLE);
  }
  const body = session ? { signedIn: true, address: shortAddress(session.addr) } : { signedIn: false };
  return json(body, 200, { "cache-control": "no-store" });
}
