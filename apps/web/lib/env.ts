function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const env = {
  escrowSweepNotice: () => process.env.ESCROW_SWEEP_NOTICE === "1",
  databaseUrl: () => required("DATABASE_URL"),
  sessionSecret: () => {
    const secret = required("SESSION_SECRET");
    if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    return secret;
  },
  internalToken: () => required("INTERNAL_TOKEN"),
  gatewayInternalUrl: () => process.env.GATEWAY_INTERNAL_URL || required("PUBLIC_BASE_URL"),
  publicBaseUrl: () => required("PUBLIC_BASE_URL").replace(/\/+$/, ""),
  webBaseUrl: () => required("WEB_BASE_URL").replace(/\/+$/, ""),
  allowInsecureUpstream: () => process.env.ALLOW_INSECURE_UPSTREAM === "1",
  chatFallback: () => process.env.CHAT_FALLBACK === "1",
  /** Optional: without it, "Ask Hirakumi" answers from its small offline FAQ. */
  openaiApiKey: () => process.env.OPENAI_API_KEY || null,
  /** Optional: the gateway's public key for sealing API keys sellers give (UPSTREAM_AUTH_PRIVATE_KEY opens them). */
  upstreamAuthPublicKey: () => process.env.UPSTREAM_AUTH_PUBLIC_KEY || null,
  /**
   * "1" lets sellers save keys made of several parts (hks3 bags: two headers, a key plus fixed text, Basic with a
   * password). Off by default: a gateway older than hks3 can't open them, so it is turned on once every gateway can.
   */
  upstreamAuthV3: () => process.env.UPSTREAM_AUTH_V3 === "1",
  /** The addresses the gateway calls sellers' APIs from (shared by all sellers), for sellers with an IP allowlist. */
  gatewayEgressIps: () => (process.env.GATEWAY_EGRESS_IPS ?? "").split(/[\s,]+/).filter((ip) => ip !== ""),
  /**
   * "1" turns on listing an API from example requests (the "I don't" option on /apis/new). Off by default: a
   * coworker older than this option fails such listings for good, so it is turned on once the new coworker runs.
   */
  samplesIntake: () => process.env.SAMPLES_INTAKE === "1",
  secureCookies: () => process.env.NODE_ENV === "production",
};
