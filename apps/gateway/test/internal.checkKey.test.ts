import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  generateUpstreamAuthKeys, KEY_FORBIDDEN_TEXT, KEY_REFUSED_TEXT, newId, sealUpstreamBag, sealUpstreamSecret, type StoredUpstreamAuth,
} from "@hirakumi/core";
import { makeHarness, type Harness } from "./helpers";

const keys = generateUpstreamAuthKeys();
const KEY = "sk_test/0123456789+abcdef";
const internal = { authorization: "Bearer internal-test-token-0123456789" };

let h: Harness;
afterEach(async () => { await h?.close(); });

/** A harness whose API has a header key saved, sealed for its own address. */
async function keyed(over: { key?: string | null; state?: string } = {}): Promise<Harness> {
  h = await makeHarness({ config: { upstreamAuthPrivateKey: over.key === undefined ? keys.privateKey : over.key }, seed: { state: over.state } });
  await h.sql`update apis set upstream_auth = ${h.sql.json(sealed(h.seeded.apiId))} where id = ${h.seeded.apiId}`;
  return h;
}
const sealed = (apiId: string, value = KEY): StoredUpstreamAuth => ({
  in: "header", name: "X-API-Key", hint: "",
  sealed: sealUpstreamSecret(keys.publicKey, { apiId, in: "header", name: "X-API-Key", origin: h.stub.origin, pathPrefix: "/" }, value),
});
const check = (body: object = {}) => request(h.app).post(`/internal/apis/${h.seeded.apiId}/check-key`).set(internal).send(body);
const callRows = async () => (await h.sql<{ n: number }[]>`select count(*)::int as n from calls`)[0]!.n;

describe("check-key classes", () => {
  it("ok: one probe call with the key, on the operation with a promise; no body, no calls row, no health change", async () => {
    await keyed();
    const r = await check();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ opened: true, class: "ok", status: 200, op: "getPrice" });
    expect(h.stub.hits()).toBe(1);
    expect(h.stub.lastHeaders()?.["x-api-key"]).toBe(KEY);
    expect(h.stub.lastHeaders()?.["x-hirakumi-probe"]).toBe("1");
    expect(await callRows()).toBe(0);
    expect(h.health.get(h.seeded.apiId)?.lastReasons ?? []).toEqual([]);
  });

  it("checks the sealed key the web app sends rather than the saved one", async () => {
    await keyed();
    await check({ stored: sealed(h.seeded.apiId, "sk_other_candidate_key") });
    expect(h.stub.lastHeaders()?.["x-api-key"]).toBe("sk_other_candidate_key");
  });

  it("refused (401) and forbidden (403) carry the status and the key reason", async () => {
    await keyed();
    h.stub.setFile("/price", '{"error":"bad key"}', { status: 401 });
    const refused = await check();
    expect(refused.body).toMatchObject({ opened: true, class: "refused", status: 401, op: "getPrice" });
    expect(refused.body.reasons[0]).toBe(KEY_REFUSED_TEXT);
    h.stub.setFile("/price", '{"error":"no"}', { status: 403 });
    const forbidden = await check();
    expect(forbidden.body).toMatchObject({ class: "forbidden", status: 403 });
    expect(forbidden.body.reasons[0]).toBe(KEY_FORBIDDEN_TEXT);
    expect(JSON.stringify([refused.body, forbidden.body])).not.toMatch(/bad key|"no"/);
  });

  it("rate_limited (429), timeout, unclear (rule failed, 5xx)", async () => {
    await keyed();
    h.stub.setFile("/price", "{}", { status: 429 });
    expect((await check()).body).toMatchObject({ class: "rate_limited", status: 429 });

    await h.close();
    h = await makeHarness({ config: { upstreamAuthPrivateKey: keys.privateKey } });
    await h.sql`update apis set upstream_auth = ${h.sql.json(sealed(h.seeded.apiId))} where id = ${h.seeded.apiId}`;
    h.stub.setMode("slow");
    const slow = await check();
    expect(slow.body).toMatchObject({ opened: true, class: "timeout", op: "getPrice" });
    expect(slow.body.status).toBeUndefined();
    h.stub.setMode("empty");
    const empty = await check();
    expect(empty.body).toMatchObject({ class: "unclear", status: 200 });
    expect(empty.body.reasons.length).toBeGreaterThan(0);
    h.stub.setMode("error500");
    expect((await check()).body).toMatchObject({ class: "unclear", status: 500, reasons: ["upstream answered 500"] });
  });

  it("echoed: an answer repeating the key is withheld; neither the key nor the body is returned", async () => {
    await keyed();
    h.stub.setMode("echo");
    const r = await check();
    expect(r.body).toEqual({ opened: true, class: "echoed", op: "getPrice", reasons: ["the answer contained the API's key, so it was withheld"] });
    expect(JSON.stringify(r.body)).not.toContain(KEY);
  });

  it("accepted_unverified: an operation with no promise yet that answers 200", async () => {
    await keyed();
    await h.sql`delete from rules where operation_id = ${h.seeded.operationId}`;
    expect((await check()).body).toEqual({ opened: true, class: "accepted_unverified", status: 200, op: "getPrice" });
  });

  it("an hks3 bag sends every part", async () => {
    await keyed();
    const parts = [{ in: "header" as const, name: "apikey" }, { in: "header" as const, name: "Authorization" }];
    const bag = sealUpstreamBag(keys.publicKey, { apiId: h.seeded.apiId, parts, origin: h.stub.origin, pathPrefix: "/" },
      { values: [KEY, `Bearer ${KEY}`], fixed: [], leak: [KEY, `Bearer ${KEY}`] });
    const r = await check({ stored: { v: 3, parts: parts.map((p) => ({ ...p, hint: "" })), sealed: bag } });
    expect(r.body).toMatchObject({ opened: true, class: "ok" });
    expect(h.stub.lastHeaders()).toMatchObject({ apikey: KEY, authorization: `Bearer ${KEY}` });
  });

  it("an hks2 candidate over a saved hks3 bag sends only the candidate's header", async () => {
    await keyed();
    const parts = [{ in: "header" as const, name: "apikey" }, { in: "header" as const, name: "Authorization" }];
    const bag = sealUpstreamBag(keys.publicKey, { apiId: h.seeded.apiId, parts, origin: h.stub.origin, pathPrefix: "/" },
      { values: [KEY, `Bearer ${KEY}`], fixed: [], leak: [KEY, `Bearer ${KEY}`] });
    await h.sql`update apis set upstream_auth = ${h.sql.json({ v: 3, parts: parts.map((p) => ({ ...p, hint: "" })), sealed: bag })} where id = ${h.seeded.apiId}`;
    h.registry.invalidate(h.seeded.apiId);
    await check({ stored: sealed(h.seeded.apiId, "sk_new_candidate_key") });
    expect(h.stub.lastHeaders()?.["x-api-key"]).toBe("sk_new_candidate_key");
    expect(h.stub.lastHeaders()?.apikey).toBeUndefined();
    expect(h.stub.lastHeaders()?.authorization).toBeUndefined();
  });
});

describe("check-key op choice", () => {
  /** Adds an enabled operation (op_id sorts before getPrice) on the stub's /other path. */
  async function addOp(opId: string, o: { method?: string; schema?: object; input?: object } = {}) {
    const id = newId("op");
    await h.sql`
      insert into operations (id, api_id, op_id, method, path, input_schema, enabled, side_effects_confirmed_none)
      values (${id}, ${h.seeded.apiId}, ${opId}, ${o.method ?? "GET"}, '/other', ${h.sql.json((o.schema ?? { type: "object" }) as never)}, true, true)`;
    if (o.input) await h.sql`insert into test_inputs (id, operation_id, input) values (${newId("ti")}, ${id}, ${h.sql.json(o.input as never)})`;
    h.stub.setFile("/other", '{"ok":true}');
  }

  it("prefers an operation with a promise, then any with a saved input", async () => {
    await keyed();
    await addOp("aaa", { input: { q: "x" } });
    expect((await check()).body.op).toBe("getPrice");
    await h.sql`delete from rules where operation_id = ${h.seeded.operationId}`;
    await h.sql`update operations set enabled = false where id = ${h.seeded.operationId}`;
    expect((await check()).body).toMatchObject({ op: "aaa", class: "accepted_unverified" });
  });

  it("falls back to a GET that needs no input, else unchecked (no_test_input)", async () => {
    await keyed();
    await h.sql`delete from test_inputs`;
    await addOp("aaa", { method: "POST" });
    await addOp("bbb", { schema: { type: "object", required: ["q"], properties: { q: { type: "string" } } } });
    expect((await check()).body).toEqual({ opened: true, class: "unchecked", why: "no_test_input" });
    expect(h.stub.fileHits("/other") + h.stub.hits()).toBe(0);
    await addOp("ccc");
    expect((await check()).body).toMatchObject({ op: "ccc", class: "accepted_unverified", status: 200 });
    expect(h.stub.fileHits("/other")).toBe(1);
  });
});

describe("check-key refusals", () => {
  it("an API whose address isn't proven, or that is retired, is not called", async () => {
    for (const state of ["endpoints_confirmed", "retired"]) {
      await keyed({ state });
      expect((await check()).body).toEqual({ opened: true, class: "unchecked", why: "not_proven" });
      expect(h.stub.hits()).toBe(0);
      await h.close();
    }
    h = undefined as unknown as Harness;
  });

  it("opened:false for a key the gateway can't open, and when it has no private key", async () => {
    await keyed();
    const otherApi = sealed(newId("api"));
    for (const stored of [otherApi, { ...sealed(h.seeded.apiId), name: "X-Other" }, "hks2.garbage", { v: 3, parts: [], sealed: "hks3.x" }, 42]) {
      expect((await check({ stored })).body).toEqual({ opened: false, class: "unchecked" });
    }
    await h.sql`update apis set upstream_auth = null where id = ${h.seeded.apiId}`;
    expect((await check()).body).toEqual({ opened: false, class: "unchecked" });
    expect(h.stub.hits()).toBe(0);
    await h.close();
    await keyed({ key: null });
    expect((await check()).body).toEqual({ opened: false, class: "unchecked" });
    expect(h.stub.hits()).toBe(0);
  });

  it("needs the internal token; 404 for an unknown API; the 7th check in a minute is refused", async () => {
    await keyed();
    expect((await request(h.app).post(`/internal/apis/${h.seeded.apiId}/check-key`).send({})).status).toBe(401);
    expect((await request(h.app).post(`/internal/apis/api_missing/check-key`).set(internal).send({})).status).toBe(404);
    for (let i = 0; i < 6; i++) expect((await check()).status).toBe(200);
    const seventh = await check();
    expect(seventh.status).toBe(429);
    expect(seventh.headers["retry-after"]).toBe("60");
    expect(h.stub.hits()).toBe(6);
  });
});
