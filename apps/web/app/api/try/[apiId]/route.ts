import { env } from "@/lib/env";
import type { ApiRouteContext } from "@/lib/http";
import { createRateLimiter, parseTryTokens } from "@/lib/try";
import { createTryHandler } from "@/lib/try-handler";

const allow = createRateLimiter(3_000);

/** Public "try it live": forwards one call to the gateway, paid from the demo pack when `paid` is true. */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const { apiId } = await ctx.params;
  const handle = createTryHandler({
    gatewayBase: env.publicBaseUrl(),
    tokens: parseTryTokens(process.env.TRY_CREDIT_TOKENS),
    allow,
  });
  return handle(req, apiId);
}
