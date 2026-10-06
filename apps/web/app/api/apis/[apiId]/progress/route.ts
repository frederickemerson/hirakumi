import { json, type ApiRouteContext } from "@/lib/http";
import { loadProgress } from "@/lib/repo/progress";
import { loadOwnedApi } from "@/lib/route-helpers";

/** Polled by waiting screens instead of re-rendering the whole page: state, timeline and the page to be on. */
export async function GET(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  return json(await loadProgress(sql, api), 200, { "cache-control": "no-store" });
}
