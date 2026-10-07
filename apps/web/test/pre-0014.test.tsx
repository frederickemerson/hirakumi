// @vitest-environment jsdom
/**
 * Deploy order: the web deployed before migration 0014 ran. Its own database has migrations 0001 to 0013 only (no
 * apis.intake_kind, samples or upstream_auth, and no challenges of kind 'header'). Pages still render, the key form
 * and the example requests option are hidden, and the routes that need 0014 answer 503 in plain words.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@hirakumi/core";
import { closeSql, getSql } from "@/lib/db";
import { DEMO_API_ID } from "@/lib/demo";
import { deleteApi } from "@/lib/repo/delete-api";
import { getApiForSeller, getLiveApi, listApisForSeller } from "@/lib/repo/apis";
import { hasAnyApiSchema, resetSchemaCheck, UPDATING } from "@/lib/repo/schema";
import { resetSelfTestSchemaCheck } from "@/lib/repo/self-test-schema";
import type { ApiState } from "@/lib/types";
import { resetDb } from "./db";
import { TEST_DATABASE_URL } from "./env";
import { MIGRATIONS_DIR, resetDatabase } from "./global-setup";
import { cookieFor, ctx, jsonRequest } from "./requests";

const session = { sellerId: "", addr: "addr_test1qseller" };
vi.mock("@/lib/page-auth", async () => ({
  requireSellerPage: async () => session,
  loadApiPage: async (apiId: string) => ({ session, api: await getApiForSeller(getSql(), apiId, session.sellerId) }),
  readPageSession: async () => session,
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {} }),
  usePathname: () => "/",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const PRE_0014_URL = (() => {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `${u.pathname}_pre0014`;
  return u.toString();
})();
const mainUrl = process.env.DATABASE_URL;

async function useDatabase(url: string) {
  await closeSql();
  process.env.DATABASE_URL = url;
  resetSchemaCheck();
  resetSelfTestSchemaCheck();
}

beforeAll(async () => {
  await resetDatabase(PRE_0014_URL, "0014");
  await useDatabase(PRE_0014_URL);
  // Sessions need 0017 (revoked session ids, used sign-in nonces) whatever else has run: it only adds two tables.
  await getSql().unsafe(readFileSync(join(MIGRATIONS_DIR, "0017_auth_sessions.sql"), "utf8"));
}, 60_000);
afterAll(async () => {
  await useDatabase(mainUrl!);
});

/** Rows as a 0013 database holds them: no intake_kind, samples or upstream_auth. */
async function seed(state: ApiState, id = newId("api")) {
  const sql = getSql();
  const sellerId = newId("sel");
  await sql`insert into sellers (id, cardano_addr) values (${sellerId}, ${`addr_test1old${sellerId}`})`;
  session.sellerId = sellerId;
  await sql`
    insert into apis (id, seller_id, name, origin, path_prefix, openapi_url, state, health)
    values (${id}, ${sellerId}, 'Old API', 'https://old.example.dev', ${`/${id}`}, 'https://old.example.dev/openapi.json', ${state}, 'healthy')`;
  return { id, sellerId, cookie: cookieFor({ id: sellerId, cardanoAddr: `addr_test1old${sellerId}` }) };
}

describe("before migration 0014", () => {
  beforeEach(resetDb);

  it("knows the migration has not run", async () => {
    expect(await hasAnyApiSchema(getSql())).toBe(false);
  });

  it("reads APIs as OpenAPI ones", async () => {
    const { id, sellerId } = await seed("live");
    expect(await getApiForSeller(getSql(), id, sellerId)).toMatchObject({ id, intakeKind: "openapi", openapiUrl: "https://old.example.dev/openapi.json" });
    expect((await listApisForSeller(getSql(), sellerId)).map((a) => a.intakeKind)).toEqual(["openapi"]);
    expect(await getLiveApi(getSql(), id)).toMatchObject({ id, intakeKind: "openapi" });
  });

  it("renders /apis, /demo, the overview and the review page, without the key form", async () => {
    const live = await seed("live", DEMO_API_ID);
    const { default: Apis } = await import("@/app/apis/page");
    render(await Apis());
    expect(screen.getByText("Old API")).toBeInTheDocument();
    const { default: Demo } = await import("@/app/demo/page");
    render(await Demo());
    const { default: Overview } = await import("@/app/apis/[apiId]/overview/page");
    render(await Overview({ params: Promise.resolve({ apiId: live.id }) }));
    const review = await seed("rule_built");
    const { default: Review } = await import("@/app/apis/[apiId]/review/page");
    render(await Review({ params: Promise.resolve({ apiId: review.id }) }));
    expect(screen.queryByRole("heading", { name: /key/i })).toBeNull();
  });

  it("the ownership step says it is being updated instead of failing", async () => {
    const api = await seed("endpoints_confirmed");
    const { default: Ownership } = await import("@/app/apis/[apiId]/ownership/page");
    render(await Ownership({ params: Promise.resolve({ apiId: api.id }) }));
    expect(screen.getByText(UPDATING)).toBeInTheDocument();
    expect(screen.queryByText(/X-Hirakumi-Verify/)).toBeNull();
    const { POST: specCheck } = await import("@/app/api/apis/[apiId]/ownership/dns-check/route");
    const { POST: walletChallenge } = await import("@/app/api/apis/[apiId]/ownership/wallet-challenge/route");
    for (const route of [specCheck, walletChallenge]) {
      const res = await route(jsonRequest(`/api/apis/${api.id}/ownership/x`, { cookie: api.cookie, body: {} }), ctx(api.id));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: UPDATING });
    }
  });

  it("the key routes and example requests answer 503; an OpenAPI link still works", async () => {
    const api = await seed("endpoints_confirmed");
    const { POST: saveKey, DELETE: removeKey } = await import("@/app/api/apis/[apiId]/upstream-auth/route");
    const saved = await saveKey(jsonRequest(`/api/apis/${api.id}/upstream-auth`, {
      cookie: api.cookie, body: { in: "header", name: "X-API-Key", value: "sk_live_0123456789abcdefWXYZ" },
    }), ctx(api.id));
    expect(saved.status).toBe(503);
    expect(await saved.json()).toEqual({ error: UPDATING });
    expect((await removeKey(jsonRequest(`/api/apis/${api.id}/upstream-auth`, { cookie: api.cookie, method: "DELETE" }), ctx(api.id))).status).toBe(503);

    const { POST: create } = await import("@/app/api/apis/route");
    const samples = await create(jsonRequest("/api/apis", {
      cookie: api.cookie, body: { mode: "samples", baseUrl: "https://new.example.dev", samples: "GET /price?symbol=ADA" },
    }));
    expect(samples.status).toBe(503);
    const link = await create(jsonRequest("/api/apis", { cookie: api.cookie, body: { openapiUrl: "https://new.example.dev/openapi.json" } }));
    expect(link.status).toBe(201);
    const again = await create(jsonRequest("/api/apis", { cookie: api.cookie, body: { openapiUrl: "https://new.example.dev/openapi.json" } }));
    expect(again.status).toBe(200);
  });

  it("/apis/new offers only the OpenAPI link", async () => {
    await seed("intake");
    const { default: NewApi } = await import("@/app/apis/new/page");
    render(await NewApi({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("radio", { name: "I don't" })).toBeNull();
    expect(screen.getByLabelText("OpenAPI link")).toBeInTheDocument();
  });

  it("deleting an API that keeps its records works", async () => {
    const api = await seed("live");
    await getSql()`insert into onboard_steps (api_id, step, status) values (${api.id}, 'register', 'done')`;
    expect(await deleteApi(getSql(), { apiId: api.id, sellerId: api.sellerId })).toMatchObject({ ok: true, recordsKept: true });
  });

  it("picks the migrations up within a minute, without a restart, once 0015 has run too", async () => {
    expect(await hasAnyApiSchema(getSql())).toBe(false);
    await getSql().unsafe(readFileSync(join(MIGRATIONS_DIR, "0014_any_api_samples.sql"), "utf8"));
    expect(await hasAnyApiSchema(getSql())).toBe(false); // cached
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      // 0014 alone (as PR #5 shipped it) has no 'header' codes yet.
      expect(await hasAnyApiSchema(getSql())).toBe(false);
      await getSql().unsafe(readFileSync(join(MIGRATIONS_DIR, "0015_header_verify.sql"), "utf8"));
      clock.mockReturnValue(now + 122_000);
      expect(await hasAnyApiSchema(getSql())).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});
