import { STATE_LABEL } from "./copy";
import { getSql, type Sql } from "./db";
import { errorJson, requireSeller, type ApiRouteContext } from "./http";
import { getApiForSeller } from "./repo/apis";
import type { SessionInfo } from "./session";
import type { Api } from "./types";

/** Every /api/apis/[apiId]/* handler starts here: signed in, and the API belongs to this seller. */
export async function loadOwnedApi(
  req: Request,
  ctx: ApiRouteContext,
): Promise<{ session: SessionInfo; api: Api; sql: Sql } | Response> {
  const session = requireSeller(req);
  if (session instanceof Response) return session;
  const { apiId } = await ctx.params;
  const sql = getSql();
  const api = await getApiForSeller(sql, apiId, session.sellerId);
  if (!api) return errorJson(404, "We couldn't find that API in your account.");
  return { session, api, sql };
}

export function wrongStep(api: Api): Response {
  return errorJson(409, `This step isn't available right now. Your API is at: ${STATE_LABEL[api.state]}. Reload the page.`);
}
