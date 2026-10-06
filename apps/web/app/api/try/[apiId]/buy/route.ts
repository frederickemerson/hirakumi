import { env } from "@/lib/env";
import type { ApiRouteContext } from "@/lib/http";
import { createRateLimiter } from "@/lib/try";
import { createBuyHandler } from "@/lib/try-buy";

/** A Cardano preprod payment settles in 20 to 60 s; the stream stays open until it does. */
export const maxDuration = 120;

const allow = createRateLimiter(5_000);

/** "Buy a pack live": the gateway buys a real pack from Hirakumi's demo wallet and streams its progress. */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const { apiId } = await ctx.params;
  const handle = createBuyHandler({ gatewayInternalUrl: env.gatewayInternalUrl(), internalToken: env.internalToken(), allow });
  return handle(req, apiId);
}
