import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  describe("without an OpenAPI file (base URL and example requests)", () => {
    const samplesBody = (o: Record<string, unknown> = {}) => ({
      mode: "samples", baseUrl: "https://price.example.dev/v1", samples: "GET /price?symbol=ADA\nGET /coins/{id=cardano}", ...o,
    });

    afterEach(() => vi.unstubAllEnvs());

    it("is refused in plain words while SAMPLES_INTAKE is off, and stores nothing", async () => {
      vi.stubEnv("SAMPLES_INTAKE", "");
      const seller = await seedSeller();
      const res = await POST(jsonRequest("/api/apis", { cookie: cookieFor(seller), body: samplesBody() }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Listing an API from example requests isn't available yet. Paste the link to your OpenAPI description instead.",
      });
      expect(await getSql()`select 1 from apis where seller_id = ${seller.id}`).toHaveLength(0);
      // An OpenAPI link still works.
      const link = await POST(jsonRequest("/api/apis", { cookie: cookieFor(seller), body: { openapiUrl: "https://price.example.dev/openapi.json" } }));
      expect(link.status).toBe(201);
    });

    it("stores the samples with no OpenAPI link, and the base's origin", async () => {
      const seller = await seedSeller();
      const res = await POST(jsonRequest("/api/apis", { cookie: cookieFor(seller), body: samplesBody() }));
      expect(res.status).toBe(201);
      const { apiId } = (await res.json()) as { apiId: string };
      const [row] = await getSql()<{ origin: string; openapiUrl: string | null; intakeKind: string; samples: unknown; name: string }[]>`
        select origin, openapi_url, intake_kind, samples, name from apis where id = ${apiId}`;
      expect(row).toEqual({
        origin: "https://price.example.dev",
        openapiUrl: null,
        intakeKind: "samples",
        samples: { base: "https://price.example.dev/v1", lines: "GET /price?symbol=ADA\nGET /coins/{id=cardano}" },
        name: "price.example.dev",
      });
    });

    it("dedupes by seller and samples base: another base, or another seller, is another API", async () => {
      const seller = await seedSeller();
      const send = (cookie: string, body: Record<string, unknown>) => POST(jsonRequest("/api/apis", { cookie, body }));
      const id = async (r: Response) => ((await r.json()) as { apiId: string }).apiId;
      const a = await id(await send(cookieFor(seller), samplesBody()));
      const v2 = await id(await send(cookieFor(seller), samplesBody({ baseUrl: "https://price.example.dev/v2" })));
      expect(v2).not.toBe(a);
      const theirs = await id(await send(cookieFor(await seedSeller()), samplesBody()));
      expect(theirs).not.toBe(a);
      const [n] = await getSql()<{ n: number }[]>`select count(*)::int as n from apis where id in (${a}, ${v2}, ${theirs})`;
      expect(n.n).toBe(3);
    });

    it("the same samples twice return the same API; corrected samples replace the earlier API, not add a second", async () => {
      const seller = await seedSeller();
      const cookie = cookieFor(seller);
      const send = (body: Record<string, unknown>) => POST(jsonRequest("/api/apis", { cookie, body }));
      const id = async (r: Response) => ((await r.json()) as { apiId: string }).apiId;
      const a = await id(await send(samplesBody()));
      expect(await id(await send(samplesBody()))).toBe(a);
      const b = await id(await send(samplesBody({ samples: "GET /price?symbol=BTC" })));
      expect(b).not.toBe(a);
      const rows = await getSql()<{ id: string; samples: { lines: string } }[]>`select id, samples from apis where seller_id = ${seller.id} and state <> 'retired'`;
      expect(rows).toEqual([{ id: b, samples: expect.objectContaining({ lines: "GET /price?symbol=BTC" }) }]);
    });

    it("keeps the earlier API once its endpoints were chosen", async () => {
      const seller = await seedSeller();
      const cookie = cookieFor(seller);
      const send = (body: Record<string, unknown>) => POST(jsonRequest("/api/apis", { cookie, body }));
      const a = ((await (await send(samplesBody())).json()) as { apiId: string }).apiId;
      await getSql()`update apis set state = 'endpoints_confirmed' where id = ${a}`;
      await send(samplesBody({ samples: "GET /price?symbol=BTC" }));
      const [row] = await getSql()`select 1 from apis where id = ${a}`;
      expect(row).toBeDefined();
    });

    it("refuses a key in the example requests, so it is neither stored nor shown to buyers", async () => {
      const seller = await seedSeller();
      const res = await POST(jsonRequest("/api/apis", {
        cookie: cookieFor(seller), body: samplesBody({ samples: "GET /price?symbol=ADA&apikey=a1b2c3d4e5f6g7h8i9j0" }),
      }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/^Line 1: "apikey" looks like your API's key/);
      expect(body.error).toMatch(/ownership page/);
      expect(body.error).not.toContain("a1b2c3d4e5f6g7h8i9j0");
      const rows = await getSql()`select 1 from apis where seller_id = ${seller.id}`;
      expect(rows).toHaveLength(0);
    });

    it("accepts crypto inputs named token, such as a contract address", async () => {
      const seller = await seedSeller();
      const res = await POST(jsonRequest("/api/apis", {
        cookie: cookieFor(seller), body: samplesBody({ samples: "GET /quote?token=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }),
      }));
      expect(res.status).toBe(201);
    });

    it("names the bad line or base URL in plain English", async () => {
      const seller = await seedSeller();
      const post = async (body: Record<string, unknown>) => {
        const res = await POST(jsonRequest("/api/apis", { cookie: cookieFor(seller), body }));
        return { status: res.status, body: await res.json() };
      };
      expect(await post(samplesBody({ samples: "GET /ok?a=1\nGET nope" }))).toEqual({ status: 400, body: { error: expect.stringMatching(/^Line 2: the path must start/) } });
      expect(await post(samplesBody({ samples: "" }))).toEqual({ status: 400, body: { error: expect.stringMatching(/at least one example request/) } });
      expect(await post(samplesBody({ baseUrl: "http://price.example.dev" }))).toEqual({ status: 400, body: { error: "The base URL must start with https://" } });
    });
  });
});
