import { reloadQuietly } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { deleteApi } from "@/lib/repo/delete-api";
import { loadOwnedApi } from "@/lib/route-helpers";

/** Delete an API at any stage. One that reached Masumi or sold is retired and hidden, keeping its records. */
export async function DELETE(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx); // CSRF guard, session, ownership (404 for anyone else's)
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  const result = await deleteApi(sql, { apiId: api.id, sellerId: session.sellerId });
  if (!result.ok) return errorJson(result.status, result.error);
  // The gateway stops selling it now instead of on its next reload.
  if (result.wasServing) await reloadQuietly(api.id);
  return json({ deleted: api.id, name: result.name, recordsKept: result.recordsKept });
}
