import { GatewayError, getFrontDoorGateway } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { frontDoorUpdatingResponse } from "@/lib/repo/schema";
import { loadOwnedApi } from "@/lib/route-helpers";

/** The API's front-door state: its origin, the hostname and its status, and the DNS record to add. */
export async function GET(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const updating = await frontDoorUpdatingResponse(loaded.sql);
  if (updating) return updating;
  try {
    return json(await getFrontDoorGateway().getFrontDoor(loaded.api.id));
  } catch (e) {
    if (e instanceof GatewayError) return errorJson(502, e.userMessage);
    throw e;
  }
}

/**
 * Stop using the front door: Hirakumi stops answering the hostname (no certificate, an error to callers). The API
 * keeps its new origin and key, and stays on sale at Hirakumi's own URL. The seller points DNS back themselves.
 */
export async function DELETE(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const updating = await frontDoorUpdatingResponse(loaded.sql);
  if (updating) return updating;
  try {
    const { host } = await getFrontDoorGateway().stopFrontDoor(loaded.api.id);
    return json({
      stopped: true, host,
      ...(host ? { undo: [`Point ${host} back at your own server: replace the record to Hirakumi with the one it had before.`] } : {}),
    });
  } catch (e) {
    if (e instanceof GatewayError) return errorJson(502, e.userMessage);
    throw e;
  }
}
