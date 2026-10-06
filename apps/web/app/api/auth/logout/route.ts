import { errorJson, sameOrigin } from "@/lib/http";
import { clearSessionCookieHeader } from "@/lib/session";

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return errorJson(403, "Cross-site request refused.");
  return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": clearSessionCookieHeader() } });
}
