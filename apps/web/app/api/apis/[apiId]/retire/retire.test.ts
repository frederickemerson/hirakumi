import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGatewayForTests, type Gateway } from "@/lib/gateway";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST } from "./route";

describe("POST /api/apis/:apiId/retire", () => {
  beforeEach(async () => {
    await resetDb();
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi: vi.fn(async () => undefined), getHealth: vi.fn() } as Gateway);
  });
  afterEach(() => setGatewayForTests(null));

  it("retires a live API", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const res = await POST(jsonRequest(`/api/apis/${api.id}/retire`, { cookie: cookieFor(seller), body: {} }), ctx(api.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "retired" });
  });

  it("refuses to retire an API that isn't live", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "registering");
    const res = await POST(jsonRequest(`/api/apis/${api.id}/retire`, { cookie: cookieFor(seller), body: {} }), ctx(api.id));
    expect(res.status).toBe(409);
  });
});
