import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSql } from "./db";
import { getApiForSeller } from "./repo/apis";
import { readSessionToken, SESSION_COOKIE, type SessionInfo } from "./session";
import type { Api } from "./types";

export async function requireSellerPage(nextPath: string): Promise<SessionInfo> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? readSessionToken(token) : null;
  if (!session) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return session;
}

export async function loadApiPage(apiId: string, nextPath: string): Promise<{ session: SessionInfo; api: Api }> {
  const session = await requireSellerPage(nextPath);
  const api = await getApiForSeller(getSql(), apiId, session.sellerId);
  if (!api) notFound();
  return { session, api };
}
