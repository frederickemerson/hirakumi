import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Adversarial tests for the web app's route handlers, run against apps/web's own test setup. The database is
// a throwaway one whose name must contain "test" (apps/web/test/global-setup.ts refuses anything else).
const web = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));
process.env.TEST_DATABASE_URL ??= "postgres://hirakumi:hirakumi@localhost:5432/hirakumi_stress_web_test";

export default defineConfig({
  root: web,
  resolve: { alias: [{ find: /^@\//, replacement: web }] },
  server: { fs: { allow: [web, here] } },
  test: {
    environment: "node",
    dir: here,
    setupFiles: [`${web}test/setup.ts`],
    globalSetup: [`${web}test/global-setup.ts`],
    include: [`${here}*.test.ts`],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
