import type { ApiRouteContext } from "@/lib/http";
import { publishApi } from "@/lib/publish";
import { loadOwnedApi } from "@/lib/route-helpers";

/** Publishes a priced API (lib/publish.ts, shared with the one-time publish link /act/<token>). */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  return publishApi(sql, api, session.sellerId);
}
