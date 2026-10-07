import { Redis } from "@upstash/redis";

export const BREAK_MODES = ["ok", "empty", "stale"] as const;
export type BreakMode = (typeof BREAK_MODES)[number];
export type ModeStore = { readonly kind: "memory" | "redis"; get(): Promise<BreakMode>; set(mode: BreakMode): Promise<void> };
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
  if (env.VERCEL) {
    throw new Error(
      "fx-api on Vercel needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL/KV_REST_API_TOKEN): the break switch must be shared by every instance",
    );
  }
  return memoryModeStore();
}
