import { reloadQuietly } from "@/lib/gateway";
import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { MIN_PRICE_MICROS, MoneyError, parsePackCalls, parseTusdm } from "@/lib/money";
import { savePricing } from "@/lib/repo/packs";
import { loadOwnedApi } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  const body = await readJson(req);
  if (!body) return errorJson(400, "Enter a pack size and prices.");
  let calls: number;
  let priceMicros: bigint;
  let escrowPriceMicros: bigint;
  try {
    calls = parsePackCalls(String(body.packCalls ?? ""));
    priceMicros = parseTusdm(String(body.packPrice ?? ""));
    escrowPriceMicros = parseTusdm(String(body.escrowPrice ?? ""));
  } catch (e) {
    if (e instanceof MoneyError) return errorJson(400, e.message);
    throw e;
  }
  if (priceMicros < MIN_PRICE_MICROS) {
    return errorJson(400, "A pack must cost at least 1 tUSDM. Cardano can't move smaller token payments cheaply.");
  }
  if (escrowPriceMicros < MIN_PRICE_MICROS) return errorJson(400, "A per-job hire must cost at least 1 tUSDM.");
  const result = await savePricing(sql, { apiId: api.id, sellerId: session.sellerId, calls, priceMicros, escrowPriceMicros });
  if (!result.ok) return errorJson(result.status, result.error);
  await reloadQuietly(api.id);
  return json({
    state: "priced",
    pack: { calls, priceMicros: priceMicros.toString(), escrowPriceMicros: escrowPriceMicros.toString() },
  });
}
