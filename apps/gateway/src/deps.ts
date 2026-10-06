import type { FacilitatorClient } from "@x402/core/server";
import type { Sql } from "@hirakumi/db";
import type { GatewayConfig } from "./config";
import type { HealthTracker } from "./health";
import type { MasumiPort } from "./masumi-port";
import type { ApiRegistry } from "./registry";

export type AppDeps = {
  sql: Sql;
  config: GatewayConfig;
  registry: ApiRegistry;
  health: HealthTracker;
  facilitator: FacilitatorClient;
  masumi: MasumiPort | null;
};
