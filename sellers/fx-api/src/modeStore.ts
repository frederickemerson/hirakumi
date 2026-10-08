import { Redis } from "@upstash/redis";

export const BREAK_MODES = ["ok", "empty", "stale"] as const;
export type BreakMode = (typeof BREAK_MODES)[number];
export type ModeStore = { readonly kind: "memory" | "redis" | "env"; get(): Promise<BreakMode>; set(mode: BreakMode): Promise<void> };
export type RedisLike = { get(key: string): Promise<unknown>; set(key: string, value: string): Promise<unknown> };
export const MODE_KEY = "hirakumi:fx-api:mode";

export function isBreakMode(x: unknown): x is BreakMode {
  return typeof x === "string" && (BREAK_MODES as readonly string[]).includes(x);
}

export function memoryModeStore(initial: BreakMode = "ok"): ModeStore {
  let mode = initial;
  return {
    kind: "memory",
    async get() { return mode; },
    async set(m) { mode = m; },
  };
}

/** Thrown by set() on a store that can't change at runtime. */
export class ReadOnlyModeError extends Error {}

/**
 * A fixed mode from BREAK_MODE, for serverless hosts with no shared store: every instance reads the same variable,
 * so the switch is consistent. Changing it means setting BREAK_MODE and redeploying.
 */
function envModeStore(raw: string | undefined): ModeStore {
  const mode: BreakMode = isBreakMode(raw) ? raw : "ok";
  return {
    kind: "env",
    async get() { return mode; },
    async set() { throw new ReadOnlyModeError("This deployment reads its mode from BREAK_MODE: set it and redeploy"); },
  };
}

export function redisModeStore(redis: RedisLike): ModeStore {
  return {
    kind: "redis",
    async get() {
      const v = await redis.get(MODE_KEY);
      return isBreakMode(v) ? v : "ok";
    },
    async set(m) { await redis.set(MODE_KEY, m); },
  };
}

export function modeStoreFromEnv(env: Record<string, string | undefined>): ModeStore {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (url && token) return redisModeStore(new Redis({ url, token }));
  // Serverless instances share no memory, so without Redis the mode comes from BREAK_MODE (same for every instance).
  if (env.VERCEL) return envModeStore(env.BREAK_MODE);
  return memoryModeStore();
}
