import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateUpstreamAuthKeys, openUpstreamSecret, type StoredUpstreamAuth } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { GatewayError, setGatewayForTests, type Gateway } from "@/lib/gateway";
import { deleteApi } from "@/lib/repo/delete-api";
import { getAuthHint, getUpstreamAuth } from "@/lib/repo/upstream-auth";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOnboardStep, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST as retire } from "../retire/route";
import { DELETE, POST } from "./route";

// Runs right after the route read the API, before it writes: a retire or delete committing in between.
const race = vi.hoisted(() => ({ between: null as null | ((apiId: string) => Promise<void>) }));
vi.mock("@/lib/route-helpers", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/route-helpers")>();
  return {
    ...real,
    loadOwnedApi: async (...args: Parameters<typeof real.loadOwnedApi>) => {
      const loaded = await real.loadOwnedApi(...args);
      if (race.between && !(loaded instanceof Response)) await race.between(loaded.api.id);
      return loaded;
    },
  };
});

const KEY = "sk_live_0123456789abcdefWXYZ";
const keys = generateUpstreamAuthKeys();

let seller: Seller;
let api: Api;
let cookie: string;
let reload: ReturnType<typeof vi.fn>;

function save(body: unknown, asCookie = cookie, id = api.id) {
  return POST(jsonRequest(`/api/apis/${id}/upstream-auth`, { cookie: asCookie, body }), ctx(id));
}
function remove(asCookie = cookie, id = api.id) {
  return DELETE(jsonRequest(`/api/apis/${id}/upstream-auth`, { cookie: asCookie, method: "DELETE" }), ctx(id));
}
async function storedRow(id = api.id) {
  const [row] = await getSql()<{ upstreamAuth: StoredUpstreamAuth | null }[]>`select upstream_auth from apis where id = ${id}`;
  return row.upstreamAuth;
}

describe("upstream auth", () => {
  beforeEach(async () => {
    await resetDb();
    seller = await seedSeller();
    api = await seedApi(seller.id, "endpoints_confirmed");
    cookie = cookieFor(seller);
    reload = vi.fn(async () => undefined);
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi: reload, getHealth: vi.fn(), getSettlement: vi.fn() } as Gateway);
    vi.stubEnv("UPSTREAM_AUTH_PUBLIC_KEY", keys.publicKey);
  });
  afterEach(() => {
    race.between = null;
    setGatewayForTests(null);
    vi.unstubAllEnvs();
  });

  it("seals the key so only the gateway's private key opens it, for this API only, and never echoes it", async () => {
    const res = await save({ in: "header", name: "X-API-Key", value: KEY });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ in: "header", name: "X-API-Key", hint: "WXYZ" });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("hks1");

    const row = await storedRow();
    expect(row).toMatchObject({ in: "header", name: "X-API-Key", hint: "WXYZ" });
    expect(typeof row).toBe("object"); // jsonb object, not a JSON string
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(openUpstreamSecret(keys.privateKey, api.id, row!.sealed)).toBe(KEY);
    expect(() => openUpstreamSecret(keys.privateKey, "api_other", row!.sealed)).toThrow();
    expect(() => openUpstreamSecret(generateUpstreamAuthKeys().privateKey, api.id, row!.sealed)).toThrow();
    expect(reload).toHaveBeenCalledWith(api.id);
  });

  it("reads back where the key goes and its hint, never the sealed key", async () => {
    await save({ in: "query", name: "api_key", value: KEY });
    const view = await getUpstreamAuth(getSql(), api.id);
    expect(view).toEqual({ in: "query", name: "api_key", hint: "WXYZ" });
  });

  it("shows no hint for a short key", async () => {
    const res = await save({ in: "header", name: "Authorization", value: "Bearer abc12" });
    expect(await res.json()).toEqual({ in: "header", name: "Authorization", hint: "" });
  });

  it("replaces a key and removes it", async () => {
    await save({ in: "header", name: "X-API-Key", value: KEY });
    await save({ in: "header", name: "X-API-Key", value: "another-key-1234567890-ABCD" });
    expect((await storedRow())?.hint).toBe("ABCD");
    const res = await remove();
    expect(res.status).toBe(200);
    expect(await storedRow()).toBeNull();
    expect(await getUpstreamAuth(getSql(), api.id)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it("answers 400 with the plain reason for a bad name or key, and stores nothing", async () => {
    const reserved = await save({ in: "header", name: "Host", value: KEY });
    expect(reserved.status).toBe(400);
    expect(((await reserved.json()) as { error: string }).error).toMatch(/Hirakumi sets the Host header itself/);
    const short = await save({ in: "header", name: "X-API-Key", value: "abc" });
    expect(short.status).toBe(400);
    const newline = await save({ in: "header", name: "X-API-Key", value: "abcdefgh\r\nX-Evil: 1" });
    expect(newline.status).toBe(400);
    expect(await newline.text()).not.toContain("abcdefgh");
    expect((await save({ in: "cookie", name: "k", value: KEY })).status).toBe(400);
    expect(await storedRow()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("answers 503 in plain words when sealing isn't configured", async () => {
    vi.stubEnv("UPSTREAM_AUTH_PUBLIC_KEY", "");
    const res = await save({ in: "header", name: "X-API-Key", value: KEY });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Adding a key isn't set up on Hirakumi right now. Try again later." });
    expect(await storedRow()).toBeNull();
  });

  it("still saves when the gateway can't be reached", async () => {
    reload.mockRejectedValue(new GatewayError("unreachable", "ECONNREFUSED"));
    const res = await save({ in: "header", name: "X-API-Key", value: KEY });
    expect(res.status).toBe(200);
    expect((await storedRow())?.hint).toBe("WXYZ");
  });

  it("refuses another seller's API and a retired API", async () => {
    const intruder = await seedSeller();
    expect((await save({ in: "header", name: "X-API-Key", value: KEY }, cookieFor(intruder))).status).toBe(404);
    expect((await remove(cookieFor(intruder))).status).toBe(404);
    const retired = await seedApi(seller.id, "retired");
    expect((await save({ in: "header", name: "X-API-Key", value: KEY }, cookie, retired.id)).status).toBe(409);
    expect((await remove(cookie, retired.id)).status).toBe(409);
    expect(await storedRow()).toBeNull();
    expect(await storedRow(retired.id)).toBeNull();
  });

  it("works for a live API, so a seller can rotate the key", async () => {
    const live = await seedApi(seller.id, "live");
    const res = await save({ in: "header", name: "X-API-Key", value: KEY }, cookie, live.id);
    expect(res.status).toBe(200);
    expect(reload).toHaveBeenCalledWith(live.id);
  });

  it("drops the key when the API is removed from the market", async () => {
    const live = await seedApi(seller.id, "live");
    await save({ in: "header", name: "X-API-Key", value: KEY }, cookie, live.id);
    expect(await storedRow(live.id)).not.toBeNull();
    expect((await retire(jsonRequest(`/api/apis/${live.id}/retire`, { cookie, body: {} }), ctx(live.id))).status).toBe(200);
    expect(await storedRow(live.id)).toBeNull();
  });

  it("runs failed test calls again once the key changes, and only then", async () => {
    const waiting = await seedApi(seller.id, "ownership_verified");
    await seedOnboardStep(waiting.id, "qa", "failed", { error: "Test calls to getPrice were refused (HTTP 401)." });
    const qaRow = async (id: string) => {
      const [row] = await getSql()<{ status: string; attempts: number; output: Record<string, unknown> | null }[]>`
        select status, attempts, output from onboard_steps where api_id = ${id} and step = 'qa'`;
      return row;
    };
    expect((await save({ in: "header", name: "X-API-Key", value: KEY }, cookie, waiting.id)).status).toBe(200);
    expect(await qaRow(waiting.id)).toEqual({ status: "pending", attempts: 0, output: {} });

    await seedOnboardStep(api.id, "qa", "failed", { error: "x" }); // not waiting on test calls: left alone
    await save({ in: "header", name: "X-API-Key", value: KEY });
    expect((await qaRow(api.id)).status).toBe("failed");

    await getSql()`update onboard_steps set status = 'failed' where api_id = ${waiting.id} and step = 'qa'`;
    expect((await remove(cookie, waiting.id)).status).toBe(200);
    expect((await qaRow(waiting.id)).status).toBe("pending");
  });

  it("reads the coworker's auth hint from the parse step", async () => {
    expect(await getAuthHint(getSql(), api.id)).toBeNull();
    await seedOnboardStep(api.id, "parse", "done", { operations: [], authHint: { in: "header", name: "Authorization", prefix: "Bearer " } });
    expect(await getAuthHint(getSql(), api.id)).toEqual({ in: "header", name: "Authorization", prefix: "Bearer " });
    const other = await seedApi(seller.id, "endpoints_confirmed");
    await seedOnboardStep(other.id, "parse", "done", { operations: [], authHint: null });
    expect(await getAuthHint(getSql(), other.id)).toBeNull();
  });

  it("doesn't write the key back onto an API retired after the route read it", async () => {
    const live = await seedApi(seller.id, "live");
    race.between = async (id) => {
      await getSql()`update apis set state = 'retired', upstream_auth = null where id = ${id}`;
    };
    const res = await save({ in: "header", name: "X-API-Key", value: KEY }, cookie, live.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This API was removed or deleted while you saved, so its key wasn't saved. Reload the page." });
    expect(await storedRow(live.id)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("doesn't write the key back onto an API deleted after the route read it", async () => {
    const live = await seedApi(seller.id, "live");
    race.between = async (id) => {
      expect(await deleteApi(getSql(), { apiId: id, sellerId: seller.id })).toMatchObject({ ok: true, recordsKept: true });
    };
    expect((await save({ in: "header", name: "X-API-Key", value: KEY }, cookie, live.id)).status).toBe(409);
    expect(await storedRow(live.id)).toBeNull();

    race.between = async (id) => {
      expect(await deleteApi(getSql(), { apiId: id, sellerId: seller.id })).toMatchObject({ ok: true, recordsKept: false });
    };
    expect((await save({ in: "header", name: "X-API-Key", value: KEY })).status).toBe(409);
    expect(await getSql()`select 1 from apis where id = ${api.id}`).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it("removing when no key is stored changes nothing: no reload, and failed test calls stay failed", async () => {
    const waiting = await seedApi(seller.id, "ownership_verified");
    await seedOnboardStep(waiting.id, "qa", "failed", { error: "Test calls to getPrice failed." });
    const res = await remove(cookie, waiting.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    const [row] = await getSql()<{ status: string; attempts: number }[]>`
      select status, attempts from onboard_steps where api_id = ${waiting.id} and step = 'qa'`;
    expect(row).toEqual({ status: "failed", attempts: 1 });
    expect(reload).not.toHaveBeenCalled();
  });

  it("a key saved on a Sokosumi task API the seller replaced (started over) doesn't run its test calls again", async () => {
    const qaStatus = async (id: string) =>
      (await getSql()<{ status: string }[]>`select status from onboard_steps where api_id = ${id} and step = 'qa'`)[0].status;
    const replaced = await seedApi(seller.id, "ownership_verified", { sokosumiTaskId: "tsk_1" });
    await getSql()`update apis set created_at = now() - interval '1 hour' where id = ${replaced.id}`;
    await seedOnboardStep(replaced.id, "qa", "failed", { error: "Test calls to getPrice were refused (HTTP 401)." });
    const newer = await seedApi(seller.id, "intake", { sokosumiTaskId: "tsk_1" });
    expect((await save({ in: "header", name: "X-API-Key", value: KEY }, cookie, replaced.id)).status).toBe(200);
    expect(await qaStatus(replaced.id)).toBe("failed");

    // Still replaced once the newer one is retired: that task was closed.
    await getSql()`update apis set state = 'retired' where id = ${newer.id}`;
    expect((await save({ in: "header", name: "X-API-Key", value: KEY }, cookie, replaced.id)).status).toBe(200);
    expect(await qaStatus(replaced.id)).toBe("failed");

    // The newest API on a task, and an API on another task, still run again.
    const latest = await seedApi(seller.id, "ownership_verified", { sokosumiTaskId: "tsk_2" });
    await getSql()`update apis set created_at = now() + interval '1 hour' where id = ${latest.id}`;
    await seedOnboardStep(latest.id, "qa", "failed", { error: "x" });
    await seedApi(seller.id, "intake", { sokosumiTaskId: "tsk_2" });
    expect((await save({ in: "header", name: "X-API-Key", value: KEY }, cookie, latest.id)).status).toBe(200);
    expect(await qaStatus(latest.id)).toBe("pending");
  });
});
