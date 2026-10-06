import { parseSelection } from "@/lib/endpoints";
import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { confirmEndpoints } from "@/lib/repo/operations";
import { loadOwnedApi } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const body = await readJson(req);
  const selection = body ? parseSelection(body) : null;
  if (!selection) return errorJson(400, "Choose at least one endpoint to sell.");
  const result = await confirmEndpoints(loaded.sql, { apiId: loaded.api.id, sellerId: loaded.session.sellerId, selection });
  if (!result.ok) return errorJson(result.status, result.error);
  return json({ state: "endpoints_confirmed" });
}
