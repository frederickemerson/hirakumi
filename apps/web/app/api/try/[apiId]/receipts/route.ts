import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { errorJson, type ApiRouteContext } from "@/lib/http";
import { envTryToken } from "@/lib/try";
import { createReceiptsHandler } from "@/lib/try-handler";
import { isLiveBuyApi } from "@/lib/try-live";
import { findTryPack } from "@/lib/try-repo";

export const dynamic = "force-dynamic";

/** The receipts of the pack "Try it live" pays with: every paid call, its verdict and hashes. */
export async function GET(_req: Request, ctx: ApiRouteContext): Promise<Response> {
  const { apiId } = await ctx.params;
  if (!isLiveBuyApi(apiId)) return errorJson(404, "Public Try it live is on featured APIs only.");
  const handle = createReceiptsHandler({
    gatewayBase: env.publicBaseUrl(),
    pack: (id) => findTryPack(getSql(), id, envTryToken(id), { withCredits: false }),
  });
  return handle(apiId);
}
