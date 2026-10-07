import type { ApiRouteContext } from "@/lib/http";
import { selfTestHandlers } from "@/lib/self-test-env";

export const dynamic = "force-dynamic";

/** The receipts of the seller's newest self-test pack. */
export async function GET(req: Request, ctx: ApiRouteContext): Promise<Response> {
  return selfTestHandlers().receipts(req, ctx);
}
