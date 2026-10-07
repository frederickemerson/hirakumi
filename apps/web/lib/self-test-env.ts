import { env } from "./env";
import { createSelfTestHandlers } from "./self-test";
import { evolutionBuilder, SelfPayError } from "./self-test-wallet";
import { createRateLimiter } from "./try";

/** Blockfrost preprod, when BLOCKFROST_BASE_URL is unset. */
const DEFAULT_BLOCKFROST_PREPROD = "https://cardano-preprod.blockfrost.io/api/v0";

// Per instance, like the public try routes: one purchase step every 5 s, one call every 3 s.
const allowBuy = createRateLimiter(5_000);
const allowCall = createRateLimiter(3_000);

/** The seller Try it live handlers wired to this deployment's gateway and Blockfrost key. */
export function selfTestHandlers() {
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  return createSelfTestHandlers({
    gatewayInternalUrl: env.gatewayInternalUrl(),
    internalToken: env.internalToken(),
    gatewayBase: env.publicBaseUrl(),
    allowBuy,
    allowCall,
    recoveryKey: env.sessionSecret(),
    build: projectId
      ? evolutionBuilder({ baseUrl: process.env.BLOCKFROST_BASE_URL || DEFAULT_BLOCKFROST_PREPROD, projectId })
      : async () => { throw new SelfPayError(503, "Paying from your wallet isn't set up on this server yet."); },
  });
}
