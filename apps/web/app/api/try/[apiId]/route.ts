import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import type { ApiRouteContext } from "@/lib/http";
import { createRateLimiter, parseTryTokens } from "@/lib/try";
import { createTryHandler } from "@/lib/try-handler";
import { demoBudgetProblem } from "@/lib/try-repo";

/** Paid tries per hour across all visitors, so the demo pack can't be drained during judging. */
const PAID_TRIES_PER_HOUR = 30;

const allow = createRateLimiter(3_000);

/** Public "try it live": forwards one call to the gateway, paid from the demo pack when `paid` is true. */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const { apiId } = await ctx.params;
  const handle = createTryHandler({
    gatewayBase: env.publicBaseUrl(),
    tokens: parseTryTokens(process.env.TRY_CREDIT_TOKENS),
    allow,
    budget: (_apiId, token) => demoBudgetProblem(getSql(), token, PAID_TRIES_PER_HOUR),
  });
  return handle(req, apiId);
}
