import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Loads the repo-root .env without overriding variables already set in the shell (e.g. an SSH-tunnel PAYMENT_SERVICE_URL). */
export function loadRootEnv(): void {
  const path = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (!existsSync(path)) return;
  const before = { ...process.env };
  process.loadEnvFile(path);
  Object.assign(process.env, before);
}
