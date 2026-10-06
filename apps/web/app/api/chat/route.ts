import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { errorJson, json, readJson, requireSeller } from "@/lib/http";
import { getApiForSeller } from "@/lib/repo/apis";
import { listChat, postSellerMessage } from "@/lib/repo/chat";

const OFF = () => errorJson(404, "Chat is turned off.");

async function ownsApi(apiId: string | null, sellerId: string): Promise<boolean> {
  return apiId === null || (await getApiForSeller(getSql(), apiId, sellerId)) !== null;
}

export async function GET(req: Request): Promise<Response> {
  if (!env.chatFallback()) return OFF();
  const session = requireSeller(req);
  if (session instanceof Response) return session;
  const params = new URL(req.url).searchParams;
  const apiId = params.get("apiId");
  const after = Number(params.get("after") ?? "0");
  if (!Number.isSafeInteger(after) || after < 0) return errorJson(400, "Reload the page.");
  if (!(await ownsApi(apiId, session.sellerId))) return errorJson(404, "We couldn't find that API in your account.");
  return json({ messages: await listChat(getSql(), session.sellerId, apiId, after) });
}

export async function POST(req: Request): Promise<Response> {
  if (!env.chatFallback()) return OFF();
  const session = requireSeller(req);
  if (session instanceof Response) return session;
  const body = await readJson(req);
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text) return errorJson(400, "Write a message first.");
  if (text.length > 4000) return errorJson(400, "Keep messages under 4,000 characters.");
  const apiId = typeof body?.apiId === "string" ? body.apiId : null;
  if (!(await ownsApi(apiId, session.sellerId))) return errorJson(404, "We couldn't find that API in your account.");
  return json({ message: await postSellerMessage(getSql(), session.sellerId, apiId, text) }, 201);
}
