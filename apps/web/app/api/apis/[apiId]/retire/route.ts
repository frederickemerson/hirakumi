import { reloadQuietly } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { transitionState } from "@/lib/repo/apis";
import { loadOwnedApi } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  const moved = await transitionState(sql, { apiId: api.id, sellerId: session.sellerId, from: ["live"], to: "retired" });
  if (!moved) return errorJson(409, "Only a live API can be removed from the market.");
  await reloadQuietly(api.id);
  return json({ state: "retired" });
}
