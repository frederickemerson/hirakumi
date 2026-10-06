import { DEFAULT_REGISTRY_URL } from "./constants.js";
import { MasumiInputError } from "./errors.js";
import type { MasumiConfig } from "./types.js";

/** Builds the config from the contract's env names (PAYMENT_SERVICE_URL, PAYMENT_SERVICE_TOKEN, REGISTRY_*). */
export function masumiConfigFromEnv(env: Record<string, string | undefined> = process.env): MasumiConfig {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new MasumiInputError(`Set ${name} (see .env.example)`);
    return value;
  };
  return {
    baseUrl: need("PAYMENT_SERVICE_URL"),
    token: need("PAYMENT_SERVICE_TOKEN"),
    network: "Preprod",
    registryUrl: env.REGISTRY_SERVICE_URL?.trim() || DEFAULT_REGISTRY_URL,
    registryToken: env.REGISTRY_API_KEY?.trim() || undefined,
  };
}
