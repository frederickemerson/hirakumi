import { undoMessage, undoSteps } from "@/lib/front-door";
import { reloadDomainQuietly, reloadQuietly } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { transitionState } from "@/lib/repo/apis";
import { detachFrontDoor, postUndoMessage } from "@/lib/repo/front-door";
import { clearUpstreamAuth } from "@/lib/repo/upstream-auth";
import { loadOwnedApi } from "@/lib/route-helpers";

/**
 * "Remove from Hirakumi": the whole monetization layer goes. Sales stop, the key is dropped, and the front door (if
 * any) is detached, so its hostname gets no certificate and the gateway stops answering it. The answer, and a chat
 * message that stays, say what the seller undoes on their side.
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  const moved = await transitionState(sql, { apiId: api.id, sellerId: session.sellerId, from: ["live"], to: "retired" });
  if (!moved) return errorJson(409, "Only a live API can be removed from the market.");
  // A retired API is never called again, so its key has no reason to stay.
  const hadKey = await clearUpstreamAuth(sql, api.id);
  const frontDoorHost = await detachFrontDoor(sql, api.id);
  await reloadQuietly(api.id);
  if (frontDoorHost) await reloadDomainQuietly(frontDoorHost);
  const undo = undoSteps({ frontDoorHost, hadKey });
  if (undo.length) await postUndoMessage(sql, { apiId: api.id, sellerId: session.sellerId, body: undoMessage(api.name, undo) });
  return json({ state: "retired", ...(undo.length ? { undo } : {}) });
}
