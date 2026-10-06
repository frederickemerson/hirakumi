function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const env = {
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
  secureCookies: () => process.env.NODE_ENV === "production",
};
