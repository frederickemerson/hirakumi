import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { deleteUnfinishedApi } from "@/lib/repo/delete-api";
import { loadOwnedApi } from "@/lib/route-helpers";

/** Delete an API that never reached the Masumi registry. Live ones are retired instead (see ./retire). */
export async function DELETE(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx); // CSRF guard, session, ownership (404 for anyone else's)
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  const result = await deleteUnfinishedApi(sql, { apiId: api.id, sellerId: session.sellerId });
  if (!result.ok) return errorJson(result.status, result.error);
  return json({ deleted: api.id, name: result.name });
}
