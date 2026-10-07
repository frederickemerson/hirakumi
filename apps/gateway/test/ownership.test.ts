import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { newId, newVerifyCode } from "@hirakumi/core";
import { anotherBase, makeHarness, seedLiveApi, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  // The stub upstream listens on an IP; the DNS proof needs a hostname. The check never calls the API.
  await h.sql`update apis set origin = 'https://price.example.dev' where id = ${h.seeded.apiId}`;
});
afterEach(async () => { await h.close(); });
const auth = () => ({ authorization: `Bearer ${h.config.internalToken}` });
const RECORD = "_hirakumi.price.example.dev";

async function giveCode(apiId: string, kind: "dns" | "header" | "openapi" = "dns"): Promise<string> {
  const code = newVerifyCode();
  await h.sql`insert into challenges (id, api_id, kind, token, expires_at)
              values (${newId("ch")}, ${apiId}, ${kind}, ${code}, now() + interval '10 years')`;
  return code;
}
const check = (apiId = h.seeded.apiId) => request(h.app).post(`/internal/challenge/${apiId}/check`).set(auth());

describe("ownership check: a TXT record at _hirakumi.<host> with the API's code", () => {
  it("passes when the record holds the code, and leaves the code for the web app to consume", async () => {
    const code = await giveCode(h.seeded.apiId);
    h.dns.set(RECORD, [code]);
    const ok = await check();
    expect(ok.body).toEqual({ ok: true, reason: "verified", record: RECORD, detail: `Found your code in the TXT record at ${RECORD}.` });
    const [row] = await h.sql<{ consumed_at: Date | null; proof: unknown }[]>`select consumed_at, proof from challenges`;
    expect(row.consumed_at).toBeNull();
    expect(row.proof).toBeNull();
    expect((await check()).body.ok).toBe(true);
  });

  it("never calls the seller's API: only one DNS lookup", async () => {
    const code = await giveCode(h.seeded.apiId);
    h.dns.set(RECORD, [code]);
    await check();
    expect(h.dns.asked).toEqual([RECORD]);
    expect(h.stub.lastUrl()).toBeNull();
    expect(h.stub.hits()).toBe(0);
  });

  it("passes when one of several TXT records at the name is the code", async () => {
    const code = await giveCode(h.seeded.apiId);
    h.dns.set(RECORD, [newVerifyCode(), code]);
    expect((await check()).body).toMatchObject({ ok: true });
  });

  it("says when there is no record yet, for no such name and for no TXT data alike", async () => {
    await giveCode(h.seeded.apiId);
    expect((await check()).body).toEqual({ ok: false, reason: "missing", record: RECORD, detail: `No TXT record found at ${RECORD} yet.` });
    h.dns.fail(RECORD, "ENODATA");
    expect((await check()).body).toMatchObject({ ok: false, reason: "missing" });
  });

  it("says when the record holds another code", async () => {
    await giveCode(h.seeded.apiId);
    h.dns.set(RECORD, [newVerifyCode()]);
    const r = (await check()).body;
    expect(r).toMatchObject({ ok: false, reason: "mismatch", record: RECORD });
    expect(r.detail).toMatch(/not with this API's code/);
  });

  it("a DNS timeout or server failure is not a missing record", async () => {
    await giveCode(h.seeded.apiId);
    h.dns.fail(RECORD, "ETIMEOUT");
    expect((await check()).body).toMatchObject({ ok: false, reason: "timeout" });
    h.dns.fail(RECORD, "ESERVFAIL");
    expect((await check()).body).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("refuses an IP address or a host with no domain, without a lookup", async () => {
    await giveCode(h.seeded.apiId);
    for (const origin of ["https://52.70.235.103", "http://localhost:8080"]) {
      await h.sql`update apis set origin = ${origin} where id = ${h.seeded.apiId}`;
      expect((await check()).body, origin).toMatchObject({ ok: false, reason: "bad_host" });
    }
    expect(h.dns.asked).toEqual([]);
  });

  it("says when there is no code for this API, without a lookup", async () => {
    h.dns.set(RECORD, ["hkv_x"]);
    expect((await check()).body).toMatchObject({ ok: false, reason: "no_code" });
    expect(h.dns.asked).toEqual([]);
  });

  it("looks up the hostname only: port, base path and case don't change the record", async () => {
    const code = await giveCode(h.seeded.apiId);
    await h.sql`update apis set origin = 'https://PRICE.example.dev:8443', path_prefix = '/v1' where id = ${h.seeded.apiId}`;
    h.dns.set(RECORD, [code]);
    expect((await check()).body).toMatchObject({ ok: true, record: RECORD });
  });

  it("verifying API X never verifies API Y on the same host: each needs its own code", async () => {
    const codeX = await giveCode(h.seeded.apiId);
    const y = await seedLiveApi(h.sql, "https://price.example.dev", { state: "endpoints_confirmed", pathPrefix: anotherBase() });
    const codeY = await giveCode(y.apiId);
    expect(codeX).not.toBe(codeY);
    h.dns.set(RECORD, [codeX]);
    expect((await check(h.seeded.apiId)).body).toMatchObject({ ok: true });
    expect((await check(y.apiId)).body).toMatchObject({ ok: false, reason: "mismatch" });
    h.dns.set(RECORD, [codeX, codeY]);
    expect((await check(y.apiId)).body).toMatchObject({ ok: true });
  });

  it("a code is never reused: the database refuses the same code for a second API", async () => {
    const code = await giveCode(h.seeded.apiId);
    const y = await seedLiveApi(h.sql, h.stub.origin, { pathPrefix: anotherBase() });
    await expect(h.sql`insert into challenges (id, api_id, kind, token, expires_at)
                       values (${newId("ch")}, ${y.apiId}, 'dns', ${code}, now() + interval '1 year')`).rejects.toThrow(/unique/);
  });

  it.each(["openapi", "header"] as const)("an open code of an older proof (%s) is not used", async (kind) => {
    const code = await giveCode(h.seeded.apiId, kind);
    h.dns.set(RECORD, [code]);
    expect((await check()).body).toMatchObject({ ok: false, reason: "no_code" });
  });

  it("works for an API given by example requests, which has no openapi_url", async () => {
    const code = await giveCode(h.seeded.apiId);
    await h.sql`update apis set openapi_url = null, intake_kind = 'samples', path_prefix = '/v1',
                samples = ${h.sql.json({ base: "https://price.example.dev/v1", lines: "GET /price?symbol=ADA" })} where id = ${h.seeded.apiId}`;
    h.dns.set(RECORD, [code]);
    expect((await check()).body).toMatchObject({ ok: true, record: RECORD });
  });

  it("is 404 for an unknown API", async () => {
    expect((await check("api_nope")).status).toBe(404);
  });
});
