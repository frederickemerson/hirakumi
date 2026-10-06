import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, jsonRequest } from "@/test/requests";
import { POST } from "./route";

const TAKEN = "This API is already listed by another account. If it's yours, retire that listing first.";

const submit = (cookie: string, openapiUrl: string, extra: Record<string, unknown> = {}) =>
  POST(jsonRequest("/api/apis", { cookie, body: { openapiUrl, name: "Price API", ...extra } }));

async function count() {
  const [r] = await getSql()<{ n: number }[]>`select count(*)::int as n from apis`;
  return r.n;
}

describe("POST /api/apis tells the seller right away when another account lists this API", () => {
  beforeEach(resetDb);

  const samples = (baseUrl: string) => ({ mode: "samples", baseUrl, samples: "GET /price?symbol=ADA" });

  it("refuses example requests whose base lies at or under another account's active base", async () => {
    const theirs = await seedSeller();
    await seedApi(theirs.id, "live", { name: "Secret Prices", pathPrefix: "/" });
    const seller = await seedSeller();
    const before = await count();
    const res = await submit(cookieFor(seller), "", samples("https://PRICE.example.dev/v1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: TAKEN });
    expect(await count()).toBe(before);
  });

  it("also through a Sokosumi setup link", async () => {
    const theirs = await seedSeller();
    await seedApi(theirs.id, "ownership_verified", { pathPrefix: "/" });
    await getSql()`insert into coworker_tasks (task_id, sokosumi_user_id, task_name, setup_token)
                   values ('tsk_early', 'usr_1', 'Sell my API', 'tok_early')`;
    const res = await submit(cookieFor(await seedSeller()), "", { ...samples("https://price.example.dev"), setupToken: "tok_early" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: TAKEN });
  });

  it("refuses a base above another account's base too (they would overlap)", async () => {
    const theirs = await seedSeller();
    await seedApi(theirs.id, "live", { pathPrefix: "/v1" });
    const res = await submit(cookieFor(await seedSeller()), "", samples("https://price.example.dev"));
    expect(res.status).toBe(409);
  });

  it("lets an OpenAPI link through: the file may be hosted anywhere, so servers[0] and the proof decide", async () => {
    const theirs = await seedSeller();
    await seedApi(theirs.id, "live", { pathPrefix: "/" });
    const res = await submit(cookieFor(await seedSeller()), "https://price.example.dev/v1/openapi.json");
    expect(res.status).toBe(201);
    const [row] = await getSql()<{ origin: string; state: string }[]>`select origin, state from apis where openapi_url = 'https://price.example.dev/v1/openapi.json'`;
    // Provisional until the parse step sets it from servers[0].
    expect(row).toEqual({ origin: "https://price.example.dev", state: "intake" });
  });

  it("ignores listings that are retired or not yet proven, another folder, and the seller's own", async () => {
    const theirs = await seedSeller();
    await seedApi(theirs.id, "retired", { pathPrefix: "/" });
    await seedApi(theirs.id, "endpoints_confirmed", { pathPrefix: "/" });
    await seedApi(theirs.id, "live", { pathPrefix: "/v2" });
    const seller = await seedSeller();
    await seedApi(seller.id, "live", { pathPrefix: "/" });
    const res = await submit(cookieFor(seller), "", samples("https://price.example.dev/v1"));
    expect(res.status).toBe(201);
  });
});
