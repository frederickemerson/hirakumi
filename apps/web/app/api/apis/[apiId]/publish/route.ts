import { reloadQuietly } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { transitionState } from "@/lib/repo/apis";
import { loadOwnedApi } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  // Only 'priced' can publish; the conditional update makes a double click a no-op.
  const moved = await transitionState(sql, { apiId: api.id, sellerId: session.sellerId, from: ["priced"], to: "registering" });
  if (!moved) return errorJson(409, "Save a price before publishing. If you already published, reload the page.");
  await reloadQuietly(api.id);
  return json({ state: "registering" });
}
