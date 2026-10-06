import type { ApiRouteContext } from "@/lib/http";
import { getOrCreateHttpChallenge } from "@/lib/repo/challenges";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

export async function GET(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  if (api.state !== "endpoints_confirmed") return wrongStep(api);
  const challenge = await getOrCreateHttpChallenge(sql, api.id);
  return new Response(challenge.token, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${api.id}.txt"`,
      "cache-control": "no-store",
    },
  });
}
