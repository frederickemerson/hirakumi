import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/test/db";
import { seedApi, seedOnboardStep, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { GET } from "./route";

describe("GET /api/apis/:apiId/progress", () => {
  beforeEach(resetDb);

  it("needs a signed-in seller", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "ownership_verified");
    const res = await GET(jsonRequest(`/api/apis/${api.id}/progress`), ctx(api.id));
    expect(res.status).toBe(401);
  });

  it("hides other sellers' APIs", async () => {
    const owner = await seedSeller();
    const other = await seedSeller();
    const api = await seedApi(owner.id, "ownership_verified");
    const res = await GET(jsonRequest(`/api/apis/${api.id}/progress`, { cookie: cookieFor(other) }), ctx(api.id));
    expect(res.status).toBe(404);
  });

  it("returns the state, the page to be on and the human timeline, never stray rows", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "ownership_verified");
    await seedOnboardStep(api.id, "parse", "done");
    await seedOnboardStep(api.id, "describe", "done");
    await seedOnboardStep(api.id, "seller_samples", "done", { getPrice: [] });
    await seedOnboardStep(api.id, "qa", "running", { progress: { done: 3, total: 6, startedAt: "2026-10-06T10:00:00.000Z" } });

    const res = await GET(jsonRequest(`/api/apis/${api.id}/progress`, { cookie: cookieFor(seller) }), ctx(api.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      state: "ownership_verified",
      step: "review",
      href: `/apis/${api.id}/review`,
      failure: null,
      settled: false,
      timeline: { done: 4, total: 7, pct: 57 },
    });
    expect(body.timeline.items.map((i: { label: string }) => i.label)).toEqual([
      "Read your file", "Describe endpoints", "Choose endpoints", "Prove ownership", "Test calls", "Write the promise", "Register on Masumi",
    ]);
    expect(body.timeline.items[4]).toMatchObject({ status: "running", progress: { done: 3, total: 6 } });
    expect(JSON.stringify(body)).not.toMatch(/seller_samples|cardano|addr_/);
  });

  it("is settled once live", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const body = await (await GET(jsonRequest(`/api/apis/${api.id}/progress`, { cookie: cookieFor(seller) }), ctx(api.id))).json();
    expect(body).toMatchObject({ state: "live", step: "overview", settled: true, timeline: { pct: 100 } });
  });
});
