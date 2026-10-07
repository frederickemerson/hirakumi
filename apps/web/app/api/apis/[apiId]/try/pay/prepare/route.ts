import type { ApiRouteContext } from "@/lib/http";
import { selfTestHandlers } from "@/lib/self-test-env";

/** Step 1 of paying from the seller's wallet: the gateway's price and the unsigned payment. */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  return selfTestHandlers().prepare(req, ctx);
}
