import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateway, parseKeyCheck, setGatewayForTests, type Gateway, type KeyCheck } from "@/lib/gateway";
import { getSql } from "@/lib/db";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { jsonResponse } from "@/test/http";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST } from "./route";

const STORED = { in: "header" as const, name: "X-API-Key", sealed: "hks2.x", hint: "WXYZ" };

describe("Check key now", () => {
  let seller: Seller;
  let api: Api;
  let checkKey: ReturnType<typeof vi.fn>;
  const check = (cookie = cookieFor(seller), id = api.id) =>
    POST(jsonRequest(`/api/apis/${id}/upstream-auth/check`, { cookie, method: "POST" }), ctx(id));

  beforeEach(async () => {
    await resetDb();
    seller = await seedSeller();
    api = await seedApi(seller.id, "ownership_verified");
    checkKey = vi.fn(async (): Promise<KeyCheck | null> => ({ opened: true, class: "refused", status: 401, op: "getPrice" }));
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi: vi.fn(), getHealth: vi.fn(), getSettlement: vi.fn(), checkKey } as Gateway);
  });
  afterEach(() => setGatewayForTests(null));

  it("asks the gateway to check the saved key and answers its check", async () => {
    await getSql()`update apis set upstream_auth = ${getSql().json(STORED)} where id = ${api.id}`;
    const res = await check();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ check: { opened: true, class: "refused", status: 401, op: "getPrice" } });
    expect(checkKey).toHaveBeenCalledWith(api.id, undefined);
  });

  it("answers 409 when no key is saved, 503 when the check couldn't run, and 404 for another seller", async () => {
    expect((await check()).status).toBe(409);
    await getSql()`update apis set upstream_auth = ${getSql().json(STORED)} where id = ${api.id}`;
    checkKey.mockResolvedValue(null);
    expect((await check()).status).toBe(503);
    expect((await check(cookieFor(await seedSeller()))).status).toBe(404);
    expect(checkKey).toHaveBeenCalledTimes(1);
  });

  it("refuses a cross-site request", async () => {
    const req = new Request(`https://web.hirakumi.test/api/apis/${api.id}/upstream-auth/check`, {
      method: "POST", headers: { cookie: cookieFor(seller), "sec-fetch-site": "cross-site" },
    });
    expect((await POST(req, ctx(api.id))).status).toBe(403);
    expect(checkKey).not.toHaveBeenCalled();
  });
});

describe("gateway checkKey", () => {
  const gatewayWith = (fetchImpl: typeof fetch) => createGateway({ baseUrl: "https://gw.test/", token: "tok", fetchImpl });

  it("posts the sealed candidate, waits up to 25 s and reads the check", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () => jsonResponse({ opened: true, class: "accepted_unverified", status: 200, op: "getPrice", reasons: ["x", 1] }));
    expect(await gatewayWith(fetchImpl).checkKey!("api_1", STORED)).toEqual({
      opened: true, class: "accepted_unverified", status: 200, op: "getPrice", reasons: ["x"],
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.test/internal/apis/api_1/check-key");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ stored: STORED });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(timeout).toHaveBeenCalledWith(25_000);
    timeout.mockRestore();
  });

  it("returns null, never throws, on a failure, an error status or an unexpected shape", async () => {
    const failing = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await gatewayWith(failing).checkKey!("api_1")).toBeNull();
    expect(await gatewayWith(vi.fn(async () => new Response("", { status: 429 }))).checkKey!("api_1")).toBeNull();
    expect(await gatewayWith(vi.fn(async () => jsonResponse({ opened: true, class: "great" }))).checkKey!("api_1")).toBeNull();
  });

  it("reads every class, and a key the gateway couldn't open", () => {
    for (const c of ["ok", "accepted_unverified", "refused", "forbidden", "rate_limited", "timeout", "echoed", "unclear", "unchecked"]) {
      expect(parseKeyCheck({ opened: true, class: c })?.class).toBe(c);
    }
    expect(parseKeyCheck({ opened: false })).toEqual({ opened: false, class: "unchecked" });
    expect(parseKeyCheck({ opened: true, class: "unchecked", why: "no_test_input" })).toEqual({ opened: true, class: "unchecked", why: "no_test_input" });
    expect(parseKeyCheck({ class: "ok" })).toBeNull();
  });
});
