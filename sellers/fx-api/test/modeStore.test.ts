import { describe, it, expect } from "vitest";
import { memoryModeStore, redisModeStore, modeStoreFromEnv, isBreakMode, MODE_KEY, type RedisLike } from "../src/modeStore.js";

function fakeRedis(): RedisLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); return "OK"; } };
}

describe("modeStore", () => {
  it("memory store defaults to ok and remembers a set", async () => {
    const s = memoryModeStore();
    expect(await s.get()).toBe("ok");
    await s.set("stale");
    expect(await s.get()).toBe("stale");
  });

  it("redis store reads and writes one key", async () => {
    const r = fakeRedis();
    const s = redisModeStore(r);
    expect(s.kind).toBe("redis");
    expect(await s.get()).toBe("ok");
    await s.set("empty");
    expect(r.data.get(MODE_KEY)).toBe("empty");
    expect(await s.get()).toBe("empty");
  });

  it("treats an unknown stored value as ok", async () => {
    const r = fakeRedis();
    r.data.set(MODE_KEY, "garbage");
    expect(await redisModeStore(r).get()).toBe("ok");
  });

  it("uses Redis when Upstash env vars are present", () => {
    expect(modeStoreFromEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }).kind).toBe("redis");
    expect(modeStoreFromEnv({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" }).kind).toBe("redis");
  });

  it("uses memory locally", () => {
    expect(modeStoreFromEnv({}).kind).toBe("memory");
  });

  it("on Vercel without Redis, reads a fixed mode from BREAK_MODE that every instance shares", async () => {
    const fixed = modeStoreFromEnv({ VERCEL: "1", BREAK_MODE: "empty" });
    expect(fixed.kind).toBe("env");
    await expect(fixed.get()).resolves.toBe("empty");
    await expect(fixed.set("ok")).rejects.toThrow(/BREAK_MODE/);
    await expect(modeStoreFromEnv({ VERCEL: "1" }).get()).resolves.toBe("ok");
  });

  it("validates modes", () => {
    expect(isBreakMode("empty")).toBe(true);
    expect(isBreakMode("broken")).toBe(false);
    expect(isBreakMode(3)).toBe(false);
  });
});
