import { afterEach, describe, expect, it, vi } from "vitest";
import { call } from "../src/http.js";
import { MasumiApiError } from "../src/errors.js";
import { fail, installFakeFetch, ok } from "./fakeFetch.js";

const BASE = "http://ps.test/api/v1";
const TOKEN = "secret-admin-key-123";

afterEach(() => vi.unstubAllGlobals());

describe("call", () => {
  it("sends the token header and unwraps the success envelope", async () => {
    const { calls } = installFakeFetch({ "GET /api/v1/health": () => ok({ status: "ok" }) });
    await expect(call(BASE, TOKEN, "GET", "/health")).resolves.toEqual({ status: "ok" });
    expect(calls[0].headers.token).toBe(TOKEN);
  });

  it("adds only defined query params", async () => {
    const { calls } = installFakeFetch({ "GET /api/v1/registry": () => ok({ Assets: [] }) });
    await call(BASE, TOKEN, "GET", "/registry", { query: { network: "Preprod", cursorId: undefined, limit: 100 } });
    expect(calls[0].url.searchParams.get("network")).toBe("Preprod");
    expect(calls[0].url.searchParams.has("cursorId")).toBe(false);
    expect(calls[0].url.searchParams.get("limit")).toBe("100");
  });

  it("sends JSON bodies with a content-type", async () => {
    const { calls } = installFakeFetch({ "POST /api/v1/payment": () => ok({ id: "p1" }) });
    await call(BASE, TOKEN, "POST", "/payment", { body: { network: "Preprod" } });
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(calls[0].body).toEqual({ network: "Preprod" });
  });

  it("throws MasumiApiError with the node's message and never leaks the token", async () => {
    installFakeFetch({
      "POST /api/v1/payment": () =>
        fail(400, `key ${TOKEN}: Submit result time must be in the future (min. 15 minutes)`),
    });
    const error = await call(BASE, TOKEN, "POST", "/payment", { body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MasumiApiError);
    expect((error as MasumiApiError).status).toBe(400);
    expect((error as MasumiApiError).path).toBe("/payment");
    expect((error as Error).message).toContain("min. 15 minutes");
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("treats a 200 without the success envelope as an error", async () => {
    installFakeFetch({ "GET /api/v1/health": () => ({ json: { hello: "world" } }) });
    await expect(call(BASE, TOKEN, "GET", "/health")).rejects.toBeInstanceOf(MasumiApiError);
  });

  it("wraps network failures as status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const error = await call(BASE, TOKEN, "GET", "/health").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MasumiApiError);
    expect((error as MasumiApiError).status).toBe(0);
  });
});
