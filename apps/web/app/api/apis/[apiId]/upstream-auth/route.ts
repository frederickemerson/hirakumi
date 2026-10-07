import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { reloadQuietly } from "@/lib/gateway";
import { updatingResponse } from "@/lib/repo/schema";
import { clearUpstreamAuth, retryFailedQa } from "@/lib/repo/upstream-auth";
import { loadOwnedApi } from "@/lib/route-helpers";
import { RETIRED, saveUpstreamKey } from "@/lib/upstream-key-save";

/** Saves the API's key (lib/upstream-key-save.ts, shared with the one-time key link /act/<token>). */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  return saveUpstreamKey(sql, api, session.sellerId, await readJson(req));
}

export async function DELETE(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  const updating = await updatingResponse(sql);
  if (updating) return updating;
  if (api.state === "retired") return errorJson(409, RETIRED);
  // No key was stored: nothing changes, so nothing reloads and failed test calls don't run again.
  if (await clearUpstreamAuth(sql, api.id)) {
    await reloadQuietly(api.id);
    await retryFailedQa(sql, api.id);
  }
  return json({ removed: true });
}
