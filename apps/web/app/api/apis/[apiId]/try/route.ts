import type { ApiRouteContext } from "@/lib/http";
import { selfTestHandlers } from "@/lib/self-test-env";

/** The seller's own Try it live: one paid call with their self-test pack. */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  return selfTestHandlers().call(req, ctx);
}
