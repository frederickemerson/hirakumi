import type { FacilitatorClient } from "@x402/core/server";
import type { Sql } from "@hirakumi/db";
import type { GatewayConfig } from "./config";
import type { HealthTracker } from "./health";
import type { EscrowChain } from "./escrowChain";
import type { MasumiPort } from "./masumi-port";
import type { ApiRegistry } from "./registry";

export type AppDeps = {
  sql: Sql;
  config: GatewayConfig;
  registry: ApiRegistry;
  health: HealthTracker;
  facilitator: FacilitatorClient;
  masumi: MasumiPort | null;
  /** The Cardano transaction hash inside an x402 payment payload, or null if it isn't one. Injected by tests. */
  paymentTxHash?: (payload: Record<string, unknown>) => string | null;
  /** PACK_MODE=escrow: reads (and, with an operator key, writes) the chain. Null → locks are verified later. */
  escrowChain?: EscrowChain | null;
};
