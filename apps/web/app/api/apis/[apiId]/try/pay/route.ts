import type { ApiRouteContext } from "@/lib/http";
import { selfTestHandlers } from "@/lib/self-test-env";

/** A Cardano preprod payment settles in 20 to 60 s; the buy waits up to 110 s, then /recover up to 20 s more. */
export const maxDuration = 150;

/** Step 2: the payment the seller's wallet signed goes to the gateway; the pack's token stays on the server. */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  return selfTestHandlers().pay(req, ctx);
}
