import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedSeller } from "@/test/factories";
import { cookieFor, jsonRequest } from "@/test/requests";
import { POST } from "./route";

describe("POST /api/apis (Setup)", () => {
  beforeEach(resetDb);

  it("requires a signed-in seller", async () => {
    const res = await POST(jsonRequest("/api/apis", { body: { openapiUrl: "https://price.example.dev/openapi.json" } }));
    expect(res.status).toBe(401);
  });

  it("creates the API in intake for the signed-in seller", async () => {
    const seller = await seedSeller();
    const res = await POST(jsonRequest("/api/apis", {
      cookie: cookieFor(seller),
      body: { openapiUrl: "https://price.example.dev/openapi.json", name: "Price API" },
    }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { apiId: string; state: string; created: boolean };
    expect(body).toMatchObject({ state: "intake", created: true });
    const [row] = await getSql()<{ sellerId: string; origin: string; state: string; name: string }[]>`
      select seller_id, origin, state, name from apis where id = ${body.apiId}`;
    expect(row).toEqual({ sellerId: seller.id, origin: "https://price.example.dev", state: "intake", name: "Price API" });
  });

  it("the same link twice returns the same API instead of a duplicate", async () => {
    const seller = await seedSeller();
    const send = () => POST(jsonRequest("/api/apis", { cookie: cookieFor(seller), body: { openapiUrl: "https://price.example.dev/openapi.json" } }));
    const [a, b] = await Promise.all([send(), send()]);
    const ids = [((await a.json()) as { apiId: string }).apiId, ((await b.json()) as { apiId: string }).apiId];
    expect(ids[0]).toBe(ids[1]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
  });

  it("pasting the same link after onboarding failed starts over instead of returning the failed API (audit I1)", async () => {
    const seller = await seedSeller();
    const cookie = cookieFor(seller);
    const body = { openapiUrl: "https://price.example.dev/openapi.json", name: "Price API" };
    const first = (await (await POST(jsonRequest("/api/apis", { cookie, body }))).json()) as { apiId: string };
    await getSql()`insert into onboard_steps (api_id, step, status, output) values (${first.apiId}, 'parse', 'failed', '{"error":"x"}'::jsonb)`;
    const again = await POST(jsonRequest("/api/apis", { cookie, body }));
    expect(again.status).toBe(201);
    expect(((await again.json()) as { apiId: string }).apiId).not.toBe(first.apiId);
  });

  it("explains a bad link in plain English", async () => {
    const seller = await seedSeller();
    const res = await POST(jsonRequest("/api/apis", { cookie: cookieFor(seller), body: { openapiUrl: "ftp://x" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The link must start with https://" });
  });
});
