import type { ApiRouteContext } from "@/lib/http";
import { selfTestHandlers } from "@/lib/self-test-env";

/** A Cardano preprod payment settles in 20 to 60 s; the stream stays open until it does. */
export const maxDuration = 120;

/** The seller's free test: Hirakumi's demo wallet buys one pack for this listing, once. */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  return selfTestHandlers().free(req, ctx);
}
