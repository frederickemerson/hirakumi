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

  it("refuses a link whose folder lies under another account's active base", async () => {
    const theirs = await seedSeller();
    await seedApi(theirs.id, "live", { name: "Secret Prices", pathPrefix: "/" });
    const seller = await seedSeller();
    const before = await count();
    const res = await submit(cookieFor(seller), "https://PRICE.example.dev/v1/openapi.json");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: TAKEN });
    expect(await count()).toBe(before);
  });

  it("also through a Sokosumi setup link", async () => {
    const theirs = await seedSeller();
    await seedApi(theirs.id, "ownership_verified", { pathPrefix: "/" });
    await getSql()`insert into coworker_tasks (task_id, sokosumi_user_id, task_name, setup_token)
                   values ('tsk_early', 'usr_1', 'Sell my API', 'tok_early')`;
    const res = await submit(cookieFor(await seedSeller()), "https://price.example.dev/openapi.json", { setupToken: "tok_early" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: TAKEN });
  });

  it("lets it through when the base is not known to clash yet (the proof of ownership decides)", async () => {
    const theirs = await seedSeller();
    await seedApi(theirs.id, "live", { pathPrefix: "/v1" });
    const res = await submit(cookieFor(await seedSeller()), "https://price.example.dev/openapi.json");
    expect(res.status).toBe(201);
  });

  it("ignores listings that are retired or not yet proven, and the seller's own", async () => {
    const theirs = await seedSeller();
    await seedApi(theirs.id, "retired", { pathPrefix: "/" });
    await seedApi(theirs.id, "endpoints_confirmed", { pathPrefix: "/" });
    const seller = await seedSeller();
    await seedApi(seller.id, "live", { pathPrefix: "/", openapiUrl: "https://price.example.dev/old.json" });
    const res = await submit(cookieFor(seller), "https://price.example.dev/openapi.json");
    expect(res.status).toBe(201);
  });
});
