import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateUpstreamAuthKeys, openUpstreamSecret } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { setFrontDoorGatewayForTests, setGatewayForTests, type FrontDoorGateway, type Gateway, type OriginSwitch } from "@/lib/gateway";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST as retire } from "../retire/route";
import { DELETE as deleteApiRoute } from "../route";
import { POST as check } from "./check/route";
import { POST as origin } from "./origin/route";
import { DELETE as stop, GET } from "./route";

const KEY = "sk_live_0123456789abcdefWXYZ";
const keys = generateUpstreamAuthKeys();
const HOST = "api.seller.dev";
const DNS_TARGET = { cname: "52-70-235-103.sslip.io", a: "52.70.235.103", aaaa: null };

let seller: Seller;
let api: Api;
let cookie: string;
let fd: { [K in keyof FrontDoorGateway]: ReturnType<typeof vi.fn> };

/** The front door as the gateway leaves it after a successful origin switch (packages/db attachFrontDoor). */
async function attach(status = "active") {
  const sql = getSql();
  await sql`insert into api_domains (host, seller_id, status, txt_verified_at) values (${HOST}, ${seller.id}, ${status}, now())`;
  await sql`update apis set public_host = ${HOST}, origin = 'https://origin.seller.dev' where id = ${api.id}`;
}

beforeEach(async () => {
  await resetDb();
  seller = await seedSeller();
  api = await seedApi(seller.id, "live", { origin: `https://${HOST}` });
  cookie = cookieFor(seller);
  setGatewayForTests({ checkChallenge: vi.fn(), reloadApi: vi.fn(async () => undefined), getHealth: vi.fn(), getSettlement: vi.fn(async () => []) } as Gateway);
  fd = {
    getFrontDoor: vi.fn(async () => ({ origin: api.origin, publicHost: null, domain: null, dnsTarget: DNS_TARGET })),
    switchOrigin: vi.fn(async (): Promise<OriginSwitch> => ({ ok: true, host: HOST, origin: "https://origin.seller.dev", tests: [], dnsTarget: DNS_TARGET })),
    checkDomain: vi.fn(async () => ({ ok: true, outcome: "routed", detail: `${HOST} is answered by Hirakumi.`, chain: [], addresses: ["52.70.235.103"] })),
    stopFrontDoor: vi.fn(async () => ({ host: HOST })),
    reloadDomain: vi.fn(async () => undefined),
  };
  setFrontDoorGatewayForTests(fd as unknown as FrontDoorGateway);
  vi.stubEnv("UPSTREAM_AUTH_PUBLIC_KEY", keys.publicKey);
});
afterEach(() => {
  setGatewayForTests(null);
  setFrontDoorGatewayForTests(null);
  vi.unstubAllEnvs();
});

const post = (handler: typeof origin, path: string, body: unknown, asCookie = cookie) =>
  handler(jsonRequest(`/api/apis/${api.id}/front-door${path}`, { cookie: asCookie, body }), ctx(api.id));

describe("POST /front-door/origin", () => {
  const body = { origin: "https://origin.seller.dev", key: { in: "header", name: "X-API-Key", value: KEY } };

  it("seals the key for the new origin, so only the gateway opens it, and never sends it in the clear", async () => {
    const res = await post(origin, "/origin", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, host: HOST });
    const [[apiId, payload]] = fd.switchOrigin.mock.calls as [[string, { origin: string; upstreamAuth: { sealed: string; hint: string } }]];
    expect(apiId).toBe(api.id);
    expect(payload.origin).toBe("https://origin.seller.dev");
    expect(JSON.stringify(payload)).not.toContain(KEY);
    expect(payload.upstreamAuth.hint).toBe("WXYZ");
    const where = { apiId: api.id, in: "header" as const, name: "X-API-Key", pathPrefix: api.pathPrefix };
    expect(openUpstreamSecret(keys.privateKey, { ...where, origin: "https://origin.seller.dev" }, payload.upstreamAuth.sealed)).toBe(KEY);
    expect(() => openUpstreamSecret(keys.privateKey, { ...where, origin: api.origin }, payload.upstreamAuth.sealed)).toThrow();
  });

  it("passes on why the gateway refused, with the test results", async () => {
    fd.switchOrigin.mockResolvedValueOnce({
      ok: false, status: 422, error: "tests_failed", detail: "Test calls to the new origin did not all pass.",
      tests: [{ opId: "getPrice", ok: false, detail: "upstream answered 401" }],
    });
    const res = await post(origin, "/origin", body);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "Test calls to the new origin did not all pass.", reason: "tests_failed",
      tests: [{ opId: "getPrice", ok: false, detail: "upstream answered 401" }],
    });
  });

  it("refuses without a key, a plain http origin, a platform's shared domain, and before ownership", async () => {
    expect((await post(origin, "/origin", { origin: body.origin })).status).toBe(400);
    expect((await post(origin, "/origin", { ...body, origin: "http://origin.seller.dev" })).status).toBe(400);
    const shared = await post(origin, "/origin", { ...body, origin: "https://my-api.vercel.app" });
    expect(shared.status).toBe(400);
    expect((await shared.json()).error).toMatch(/shared domain/);
    const other = await seedApi(seller.id, "endpoints_confirmed");
    const early = await origin(jsonRequest(`/api/apis/${other.id}/front-door/origin`, { cookie, body }), ctx(other.id));
    expect(early.status).toBe(409);
    expect(fd.switchOrigin).not.toHaveBeenCalled();
  });

  it("is only for the API's owner", async () => {
    const stranger = await seedSeller();
    expect((await post(origin, "/origin", body, cookieFor(stranger))).status).toBe(404);
  });
});

describe("check and stop", () => {
  it("checks the API's own host, and needs one", async () => {
    expect((await post(check, "/check", {})).status).toBe(409);
    await attach("pending_dns");
    const res = await post(check, "/check", {});
    expect(res.status).toBe(200);
    expect(fd.checkDomain).toHaveBeenCalledWith(HOST);
    expect((await res.json()).ok).toBe(true);
  });

  it("GET shows the state; DELETE stops and says what to point back", async () => {
    expect((await GET(jsonRequest(`/api/apis/${api.id}/front-door`, { cookie, method: "GET" }), ctx(api.id))).status).toBe(200);
    const res = await stop(jsonRequest(`/api/apis/${api.id}/front-door`, { cookie, method: "DELETE" }), ctx(api.id));
    expect(await res.json()).toMatchObject({ stopped: true, host: HOST, undo: [expect.stringContaining(`Point ${HOST} back`)] });
  });
});

describe("removing the API from Hirakumi detaches its front door", () => {
  const domainRow = async () => (await getSql()<{ status: string }[]>`select status from api_domains where host = ${HOST}`)[0];
  const publicHost = async () => (await getSql()<{ publicHost: string | null }[]>`select public_host from apis where id = ${api.id}`)[0]?.publicHost;

  it("retire: detached (no certificate), public_host cleared, the gateway told, and the steps to undo kept in chat", async () => {
    await attach();
    await getSql()`update apis set upstream_auth = ${getSql().json({ in: "header", name: "X-API-Key", sealed: "hks2.x", hint: "WXYZ" })} where id = ${api.id}`;
    const res = await retire(jsonRequest(`/api/apis/${api.id}/retire`, { cookie, body: {} }), ctx(api.id));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.state).toBe("retired");
    expect(out.undo).toHaveLength(2);
    expect(out.undo[0]).toContain(`Point ${HOST} back at your own server`);
    expect(out.undo[1]).toMatch(/still asks for the key/);
    expect((await domainRow()).status).toBe("detached");
    expect(await publicHost()).toBeNull();
    expect(fd.reloadDomain).toHaveBeenCalledWith(HOST);
    const [msg] = await getSql()<{ body: string }[]>`select body from messages where api_id = ${api.id}`;
    expect(msg.body).toContain(`Point ${HOST} back`);
    for (const s of out.undo as string[]) expect(s).not.toMatch(/[\u2013\u2014]/);
  });

  it("retire without a front door or key answers as before", async () => {
    const res = await retire(jsonRequest(`/api/apis/${api.id}/retire`, { cookie, body: {} }), ctx(api.id));
    expect(await res.json()).toEqual({ state: "retired" });
  });

  it("delete: the same, for an API whose records stay", async () => {
    await attach();
    const res = await deleteApiRoute(jsonRequest(`/api/apis/${api.id}`, { cookie, method: "DELETE" }), ctx(api.id));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ recordsKept: true, undo: [expect.stringContaining(`Point ${HOST} back`)] });
    expect((await domainRow()).status).toBe("detached");
    expect(await publicHost()).toBeNull();
    expect(fd.reloadDomain).toHaveBeenCalledWith(HOST);
  });

  it("delete: an erased API leaves its host detached, not dangling", async () => {
    await getSql()`update apis set state = 'priced' where id = ${api.id}`;
    await attach();
    const res = await deleteApiRoute(jsonRequest(`/api/apis/${api.id}`, { cookie, method: "DELETE" }), ctx(api.id));
    expect(await res.json()).toMatchObject({ recordsKept: false, undo: [expect.stringContaining(HOST)] });
    expect((await getSql()`select 1 from apis where id = ${api.id}`).length).toBe(0);
    expect((await domainRow()).status).toBe("detached");
    const [msg] = await getSql()<{ body: string; apiId: string | null }[]>`select body, api_id from messages where seller_id = ${seller.id}`;
    expect(msg).toMatchObject({ apiId: null });
  });
});
