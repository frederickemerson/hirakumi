import { createHash, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { checkExposure, exposureRefusal } from "@/lib/exposure";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Bearer INTERNAL_TOKEN, compared in constant time. */
function authorized(req: Request): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  return !!m && timingSafeEqual(digest(m[1]), digest(env.internalToken()));
}

/**
 * The leak check for the coworker (a Sokosumi task has no review page): the same check as "Check again" and the
 * publish step (lib/exposure.ts), run here so the seller's API sees the web app's address, not the gateway's host,
 * where the coworker runs. Stores the result like the page does. Internal only: INTERNAL_TOKEN.
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  if (!authorized(req)) return errorJson(401, "unauthorized");
  const { apiId } = await ctx.params;
  if (apiId.includes("\u0000")) return errorJson(404, "api_not_found");
  const report = await checkExposure(getSql(), apiId);
  if (!report) return errorJson(404, "api_not_found");
  return json({ ...report, message: exposureRefusal(report) });
}
