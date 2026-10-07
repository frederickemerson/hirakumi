import type { ApiRouteContext } from "@/lib/http";
import { selfTestHandlers } from "@/lib/self-test-env";

/** A pending wallet payment, asked again with the same signed body: only reads its outcome, never pays. */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  return selfTestHandlers().resume(req, ctx);
}
