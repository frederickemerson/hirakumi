import { createPreprodFundsHandler, DEFAULT_BLOCKFROST_PREPROD } from "@/lib/preprod-funds";
import { createRateLimiter } from "@/lib/try";

// One lookup per visitor every 2 s keeps the Blockfrost quota safe; a limited visitor just gets "unknown".
const allow = createRateLimiter(2_000);

export async function POST(req: Request): Promise<Response> {
  const handler = createPreprodFundsHandler({
    projectId: process.env.BLOCKFROST_PROJECT_ID,
    baseUrl: process.env.BLOCKFROST_BASE_URL || DEFAULT_BLOCKFROST_PREPROD,
    allow,
  });
  return handler(req);
}
