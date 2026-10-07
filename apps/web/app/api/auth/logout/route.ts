import { getSql } from "@/lib/db";
import { errorJson, sameOrigin } from "@/lib/http";
import { revokeSession } from "@/lib/repo/sessions";
import { clearSessionCookieHeader, readCookie, SESSION_COOKIE } from "@/lib/session";

/** Ends this session on the server too, so a copy of the cookie stops working. The seller's other sessions stay. */
export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return errorJson(403, "Cross-site request refused.");
  try {
    await revokeSession(getSql(), readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  } catch (e) {
    // Keep the cookie: clearing it would hide a session that still works, and the seller can try again.
    console.error("logout: revoke unavailable", e instanceof Error ? e.message : e);
    return errorJson(503, "We couldn't sign you out just now. Try again.");
  }
  return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": clearSessionCookieHeader() } });
}
