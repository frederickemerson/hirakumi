import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../../.env") });

export function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in the repo-root .env`);
    process.exit(1);
  }
  return v;
}
