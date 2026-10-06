export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi_web_test";

export const TEST_ENV: Record<string, string> = {
  DATABASE_URL: TEST_DATABASE_URL, // always the test database: tests truncate tables
  SESSION_SECRET: "test-session-secret-0123456789abcdef",
  INTERNAL_TOKEN: "test-internal-token",
  PUBLIC_BASE_URL: "https://api.hirakumi.test",
  GATEWAY_INTERNAL_URL: "https://gateway.hirakumi.test",
  WEB_BASE_URL: "https://web.hirakumi.test",
  ALLOW_INSECURE_UPSTREAM: "0",
  CHAT_FALLBACK: "1",
};
