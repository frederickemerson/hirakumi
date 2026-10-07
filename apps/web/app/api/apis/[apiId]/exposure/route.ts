import { checkExposure, exposureRefusal } from "@/lib/exposure";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

/** States with saved test inputs and promises to check against. */
const CHECKABLE = new Set(["rule_built", "priced", "registering", "live"]);

/**
 * "Check again": runs the leak check now (lib/exposure.ts) and stores the result. The answer carries the result,
 * each endpoint's outcome and, unless every endpoint refused, what blocks publishing.
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  if (!CHECKABLE.has(api.state)) return wrongStep(api);
  const report = await checkExposure(sql, api.id);
  if (!report) return errorJson(404, "We couldn't find that API in your account.");
  return json({ ...report, message: exposureRefusal(report) });
}
