import { shortAddress } from "@/lib/copy";
import { json } from "@/lib/http";
import { readCookie, readSessionToken, SESSION_COOKIE } from "@/lib/session";

/**
 * Who is signed in, for the header's client island. The session cookie is HttpOnly, so the static
 * pages ask here instead of reading it. Only the short address leaves the server, never the seller id.
 */
export async function GET(req: Request): Promise<Response> {
  const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  const session = token ? readSessionToken(token) : null;
  const body = session ? { signedIn: true, address: shortAddress(session.addr) } : { signedIn: false };
  return json(body, 200, { "cache-control": "no-store" });
}
