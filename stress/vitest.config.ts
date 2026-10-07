import { defineConfig } from "vitest/config";

// Property tests (prop/) and in-process gateway abuse tests (gateway/). Local only: the gateway tests use a
// throwaway schema in TEST_DATABASE_URL (run.mjs points it at a fresh hirakumi_stress_test database).
export default defineConfig({
  test: {
    include: ["prop/**/*.test.ts", "gateway/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    env: { ALLOW_INSECURE_UPSTREAM: "1" },
  },
});
