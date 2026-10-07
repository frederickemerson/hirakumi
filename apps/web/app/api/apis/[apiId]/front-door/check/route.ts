import { GatewayError, getFrontDoorGateway } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { getFrontDoorSummary } from "@/lib/repo/front-door";
import { frontDoorUpdatingResponse } from "@/lib/repo/schema";
import { loadOwnedApi } from "@/lib/route-helpers";

/**
 * Check connection: the gateway looks the hostname up (every address must be Hirakumi's) and makes one HTTPS
 * request to it. When the front door answers, the hostname is connected.
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const updating = await frontDoorUpdatingResponse(loaded.sql);
  if (updating) return updating;
  const summary = await getFrontDoorSummary(loaded.sql, loaded.api.id);
  if (!summary) return errorJson(409, "Set up the new origin first. Then point your hostname at Hirakumi and check again.");
  try {
    return json(await getFrontDoorGateway().checkDomain(summary.host));
  } catch (e) {
    if (e instanceof GatewayError) return errorJson(502, e.userMessage);
    throw e;
  }
}
