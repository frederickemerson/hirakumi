import { clearSessionCookieHeader } from "@/lib/session";

export async function POST(_req: Request): Promise<Response> {
  return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": clearSessionCookieHeader() } });
}
