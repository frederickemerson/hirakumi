import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSql } from "./db";
import { getApiForSeller } from "./repo/apis";
import { readSessionToken, SESSION_COOKIE, type SessionInfo } from "./session";
import type { Api } from "./types";

/** The session behind this request, or null. Reading cookies makes the page dynamic. */
export async function readPageSession(): Promise<SessionInfo | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? readSessionToken(token) : null;
}

export async function requireSellerPage(nextPath: string): Promise<SessionInfo> {
  const session = await readPageSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return session;
}

export async function loadApiPage(apiId: string, nextPath: string): Promise<{ session: SessionInfo; api: Api }> {
  const session = await requireSellerPage(nextPath);
  const api = await getApiForSeller(getSql(), apiId, session.sellerId);
  if (!api) notFound();
  return { session, api };
}
