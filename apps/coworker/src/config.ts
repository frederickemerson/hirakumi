export type Config = {
  databaseUrl: string;
  publicBaseUrl: string;
  gatewayInternalUrl: string;
  internalToken: string;
  webBaseUrl: string;
  /** The one LLM step: OpenAI when OPENAI_API_KEY is set, otherwise Anthropic. */
  llm: { provider: "openai" | "anthropic"; apiKey: string };
  /** null = dashboard-chat fallback mode (SOKOSUMI_COWORKER_API_KEY empty). */
  sokosumi: { apiUrl: string; apiKey: string } | null;
  masumi: { baseUrl: string; token: string; network: "Preprod"; registryUrl: string; registryToken?: string };
  escrowUnit: string;
  onboardingCredits: number;
};

const stripSlash = (s: string) => s.replace(/\/+$/, "");

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function llmFrom(env: Record<string, string | undefined>): Config["llm"] {
  const openai = env.OPENAI_API_KEY?.trim();
  if (openai) return { provider: "openai", apiKey: openai };
  const anthropic = env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) return { provider: "anthropic", apiKey: anthropic };
  throw new Error("Set OPENAI_API_KEY or ANTHROPIC_API_KEY (the coworker's one LLM step)");
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const sokosumiKey = env.SOKOSUMI_COWORKER_API_KEY?.trim() ?? "";
  const credits = Number(env.COWORKER_ONBOARDING_CREDITS?.trim() || "1500");
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error("COWORKER_ONBOARDING_CREDITS must be a positive number");
  }
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    publicBaseUrl: stripSlash(required(env, "PUBLIC_BASE_URL")),
    gatewayInternalUrl: stripSlash(
      env.GATEWAY_INTERNAL_URL?.trim() || `http://gateway:${env.GATEWAY_PORT?.trim() || "4021"}`,
    ),
    internalToken: required(env, "INTERNAL_TOKEN"),
    webBaseUrl: stripSlash(required(env, "WEB_BASE_URL")),
    llm: llmFrom(env),
    sokosumi: sokosumiKey
      ? {
          // The client appends /v1 itself, like pi-sokosumi does.
          apiUrl: stripSlash(env.SOKOSUMI_API_URL?.trim() || "https://api.preprod.sokosumi.com").replace(/\/v1$/, ""),
          apiKey: sokosumiKey,
        }
      : null,
    masumi: {
      baseUrl: stripSlash(required(env, "PAYMENT_SERVICE_URL")),
      token: required(env, "PAYMENT_SERVICE_TOKEN"),
      network: "Preprod",
      // Registry status checks need a token; without one the register step goes Live on the minted NFT.
      registryUrl: stripSlash(env.REGISTRY_SERVICE_URL?.trim() || "https://registry.masumi.network/api/v1"),
      registryToken: env.REGISTRY_API_KEY?.trim() || undefined,
    },
    escrowUnit: required(env, "MASUMI_ESCROW_UNIT"),
    onboardingCredits: credits,
  };
}
