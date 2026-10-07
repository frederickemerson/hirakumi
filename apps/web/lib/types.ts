export const API_STATES = [
  "intake",
  "parsed",
  "described",
  "endpoints_confirmed",
  "ownership_verified",
  "rule_built",
  "priced",
  "registering",
  "live",
  "retired",
] as const;
export type ApiState = (typeof API_STATES)[number];
export type Health = "healthy" | "down";

export type Seller = { id: string; cardanoAddr: string };

export type Api = {
  id: string;
  sellerId: string;
  name: string;
  /**
   * The API's origin. For an OpenAPI link it is provisional (the link's origin) until the parse step sets it from
   * servers[0]; trust it, and pathPrefix, only from state "parsed" on.
   */
  origin: string;
  pathPrefix: string;
  /** The OpenAPI link the seller gave, hosted anywhere. Null for intakeKind "samples". */
  openapiUrl: string | null;
  intakeKind: "openapi" | "samples";
  state: ApiState;
  health: Health;
  healthCheckedAt: Date | null;
  escrowOpId: string | null;
  agentIdentifier: string | null;
  createdAt: Date;
};

export type Operation = {
  id: string;
  opId: string;
  method: string;
  path: string;
  description: string | null;
  sideEffectsLikely: boolean;
  sideEffectsConfirmedNone: boolean;
  enabled: boolean;
};

export type OnboardStepStatus = "pending" | "running" | "done" | "failed" | "waiting_seller";
export type OnboardStep = { step: string; status: OnboardStepStatus; output: unknown; updatedAt: Date };

export type RuleView = {
  operationId: string;
  opId: string;
  method: string;
  path: string;
  version: number;
  hash: string;
  definition: unknown;
  plainEnglish: string | null;
  /** A text promise that checks only the status and error pages (@hirakumi/core isStatusOnlyRule). */
  statusOnly: boolean;
  /** The phrases every good answer must contain (@hirakumi/core requiredPhrasesOf). */
  requiredPhrases: string[];
};

export type Pack = { id: string; calls: number; priceMicros: string; escrowPriceMicros: string };

export type RepoResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };
