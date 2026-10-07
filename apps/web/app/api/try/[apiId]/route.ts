import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { errorJson, type ApiRouteContext } from "@/lib/http";
import { createRateLimiter, envTryToken } from "@/lib/try";
import { createTryHandler } from "@/lib/try-handler";
import { isLiveBuyApi } from "@/lib/try-live";
import { demoBudgetProblem, findTryPack, tryEscrowStore } from "@/lib/try-repo";

/** Paid tries per hour per pack across all visitors, so one pack can't be drained in a minute. */
const PAID_TRIES_PER_HOUR = 30;

const allow = createRateLimiter(3_000);

/**
 * Public "Try it live": one paid call through the gateway with the API's live pack (or the TRY_CREDIT_TOKENS one).
 * Showcase APIs (TRY_LIVE_APIS) only; a seller tests their own API from the dashboard (/api/apis/[apiId]/try).
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const { apiId } = await ctx.params;
  if (!isLiveBuyApi(apiId)) return errorJson(404, "Public Try it live is on featured APIs only.");
  const handle = createTryHandler({
    gatewayBase: env.publicBaseUrl(),
    pack: (id) => findTryPack(getSql(), id, envTryToken(id)),
    allow,
    budget: (_apiId, token) => demoBudgetProblem(getSql(), token, PAID_TRIES_PER_HOUR),
    escrow: tryEscrowStore(getSql()),
  });
  return handle(req, apiId);
}
