import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { newId, newVerifyCode } from "@hirakumi/core";
import { anotherBase, makeHarness, seedLiveApi, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });
const auth = () => ({ authorization: `Bearer ${h.config.internalToken}` });

async function giveCode(apiId: string): Promise<string> {
  const code = newVerifyCode();
  await h.sql`insert into challenges (id, api_id, kind, token, expires_at)
              values (${newId("ch")}, ${apiId}, 'header', ${code}, now() + interval '10 years')`;
  return code;
}
const check = (apiId = h.seeded.apiId) => request(h.app).post(`/internal/challenge/${apiId}/check`).set(auth());
const setBase = (pathPrefix: string, apiId = h.seeded.apiId) => h.sql`update apis set path_prefix = ${pathPrefix} where id = ${apiId}`;
/** Serve the root ("/" base) with these headers and this status. */
const serveRoot = (headers: Record<string, string | string[]>, status = 200) => h.stub.setFile("/", "<html>hi</html>", { status, contentType: "text/html", headers });

describe("ownership check: the X-Hirakumi-Verify header at the API's base URL", () => {
  it("passes on a 200 and leaves the code for the web app to consume", async () => {
    const code = await giveCode(h.seeded.apiId);
    serveRoot({ "X-Hirakumi-Verify": code });
    const ok = await check();
    expect(ok.body).toEqual({ ok: true, reason: "verified", triedUrl: `${h.stub.origin}/`, detail: "Found your code in the X-Hirakumi-Verify header.", status: 200 });
    const [row] = await h.sql<{ consumed_at: Date | null; proof: unknown }[]>`select consumed_at, proof from challenges`;
    expect(row.consumed_at).toBeNull();
    expect(row.proof).toBeNull();
    expect((await check()).body.ok).toBe(true);
  });

  it.each([404, 500, 401])("passes on a %s: any status proves control of the answers", async (status) => {
    const code = await giveCode(h.seeded.apiId);
    serveRoot({ "x-hirakumi-verify": code }, status);
    expect((await check()).body).toMatchObject({ ok: true, reason: "verified", status });
  });

  it("passes on a 302 and does not follow it", async () => {
    const code = await giveCode(h.seeded.apiId);
    h.stub.setFile("/elsewhere", "", { headers: { "x-hirakumi-verify": "hkv_not-the-code" } });
    serveRoot({ "x-hirakumi-verify": code, location: `${h.stub.origin}/elsewhere` }, 302);
    expect((await check()).body).toMatchObject({ ok: true, reason: "verified", status: 302 });
    expect(h.stub.fileHits("/elsewhere")).toBe(0);
  });

  it("follows exactly one redirect from /v1 to /v1/ (same base), relative or absolute", async () => {
    const code = await giveCode(h.seeded.apiId);
    await setBase("/v1");
    h.stub.setFile("/v1", "", { status: 301, headers: { location: "/v1/" } });
    h.stub.setFile("/v1/", "", { status: 404, headers: { "x-hirakumi-verify": code } });
    expect((await check()).body).toMatchObject({ ok: true, reason: "verified", status: 404, triedUrl: `${h.stub.origin}/v1/` });
    h.stub.setFile("/v1", "", { status: 308, headers: { location: `${h.stub.origin}/v1/` } });
    expect((await check()).body).toMatchObject({ ok: true, reason: "verified" });
  });

  it("does not follow a /v1 redirect anywhere but /v1/, nor a second hop", async () => {
    const code = await giveCode(h.seeded.apiId);
    await setBase("/v1");
    h.stub.setFile("/v1/other", "", { headers: { "x-hirakumi-verify": code } });
    h.stub.setFile("/v1", "", { status: 302, headers: { location: "/v1/other" } });
    expect((await check()).body).toMatchObject({ ok: false, reason: "missing", status: 302, triedUrl: `${h.stub.origin}/v1` });
    expect(h.stub.fileHits("/v1/other")).toBe(0);
    h.stub.setFile("/v1", "", { status: 301, headers: { location: "/v1/" } });
    h.stub.setFile("/v1/", "", { status: 301, headers: { location: "/v1/other" } });
    expect((await check()).body).toMatchObject({ ok: false, reason: "missing", status: 301, triedUrl: `${h.stub.origin}/v1/` });
    expect(h.stub.fileHits("/v1/other")).toBe(0);
  });

  it("a redirect to a page with the code proves nothing", async () => {
    const code = await giveCode(h.seeded.apiId);
    h.stub.setFile("/elsewhere", "", { headers: { "x-hirakumi-verify": code } });
    serveRoot({ location: `${h.stub.origin}/elsewhere` }, 301);
    expect((await check()).body).toMatchObject({ ok: false, reason: "missing", status: 301 });
    expect(h.stub.fileHits("/elsewhere")).toBe(0);
  });

  it("reads the header name in any case, and a trimmed value", async () => {
    const code = await giveCode(h.seeded.apiId);
    serveRoot({ "X-HIRAKUMI-VERIFY": `  ${code} ` });
    expect((await check()).body).toMatchObject({ ok: true });
  });

  it("passes when one of several values is the code, comma-joined or repeated", async () => {
    const code = await giveCode(h.seeded.apiId);
    serveRoot({ "x-hirakumi-verify": `hkv_other, ${code}` });
    expect((await check()).body).toMatchObject({ ok: true });
    serveRoot({ "x-hirakumi-verify": ["hkv_other", code] });
    expect((await check()).body).toMatchObject({ ok: true });
  });

  it("says when the header is missing, with the status", async () => {
    await giveCode(h.seeded.apiId);
    const r = (await check()).body; // nothing served at the root: the stub's plain 404
    expect(r).toMatchObject({ ok: false, reason: "missing", status: 404, triedUrl: `${h.stub.origin}/` });
    expect(r.detail).toBe("Your server answered 404, but without the X-Hirakumi-Verify header.");
  });

  it("says when the code is wrong", async () => {
    await giveCode(h.seeded.apiId);
    serveRoot({ "x-hirakumi-verify": "hkv_not-the-code, also-not" });
    const r = (await check()).body;
    expect(r).toMatchObject({ ok: false, reason: "mismatch", status: 200 });
    expect(r.detail).toMatch(/does not match this API's code/);
  });

  it("says when there is no code for this API, without calling the server", async () => {
    serveRoot({ "x-hirakumi-verify": "hkv_x" });
    expect((await check()).body).toMatchObject({ ok: false, reason: "no_code" });
    expect(h.stub.fileHits("/")).toBe(0);
  });

  it("sends one plain GET to exactly the base URL: no query, no body, no seller values", async () => {
    const code = await giveCode(h.seeded.apiId);
    await setBase("/v1");
    h.stub.setFile("/v1", "", { headers: { "x-hirakumi-verify": code } });
    expect((await check()).body).toMatchObject({ ok: true, triedUrl: `${h.stub.origin}/v1` });
    expect(h.stub.lastUrl()).toBe("/v1");
    expect(h.stub.fileHits("/v1")).toBe(1);
    // A fixed User-Agent, so a WAF that stops requests without one lets the check through.
    expect(h.stub.lastFileHeaders()).toMatchObject({ "user-agent": "hirakumi-gateway/0.1", accept: "*/*" });
    expect(h.stub.hits()).toBe(0); // never an operation such as /price?symbol=ADA
  });

  it("an empty base path means the root", async () => {
    const code = await giveCode(h.seeded.apiId);
    await setBase("");
    serveRoot({ "x-hirakumi-verify": code });
    expect((await check()).body).toMatchObject({ ok: true, triedUrl: `${h.stub.origin}/` });
    expect(h.stub.lastUrl()).toBe("/");
  });

  it("refuses a base URL with a query, without calling the server", async () => {
    await giveCode(h.seeded.apiId);
    await setBase("/v1?x=1");
    expect((await check()).body).toMatchObject({ ok: false, reason: "bad_url" });
    expect(h.stub.lastUrl()).toBeNull();
  });

  it("refuses a base URL that carries the code, so a reflection service proves nothing", async () => {
    const code = await giveCode(h.seeded.apiId);
    await setBase(`/response-headers/X-Hirakumi-Verify/${code}`);
    h.stub.setFile(`/response-headers/X-Hirakumi-Verify/${code}`, "", { headers: { "x-hirakumi-verify": code } });
    const r = (await check()).body;
    expect(r).toMatchObject({ ok: false, reason: "bad_url" });
    expect(r.detail).toMatch(/contains the verification code/);
    expect(h.stub.lastUrl()).toBeNull();
  });

  it("refuses an ambiguous base path, without calling the server", async () => {
    await giveCode(h.seeded.apiId);
    for (const p of ["/a%2Fb", "/a;b", "/a/../b"]) {
      await setBase(p);
      expect((await check()).body, p).toMatchObject({ ok: false, reason: "bad_url" });
    }
    expect(h.stub.lastUrl()).toBeNull();
  });

  it("refuses a blocked address (SSRF)", async () => {
    await giveCode(h.seeded.apiId);
    await h.sql`update apis set origin = 'https://169.254.169.254' where id = ${h.seeded.apiId}`;
    expect((await check()).body).toMatchObject({ ok: false, reason: "blocked", triedUrl: "https://169.254.169.254/" });
  });

  it("times out on a slow server", async () => {
    await giveCode(h.seeded.apiId);
    await setBase("/price");
    h.stub.setMode("slow");
    const r = (await check()).body;
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(r.detail).toMatch(/did not answer within 0.5 seconds/);
  });

  it("reads only the headers: a page over 1 MB at the base still passes", async () => {
    const code = await giveCode(h.seeded.apiId);
    h.stub.setFile("/", "x".repeat(2_000_000), { contentType: "text/html", headers: { "x-hirakumi-verify": code } });
    expect((await check()).body).toMatchObject({ ok: true, reason: "verified", status: 200 });
  });

  it("verifying API X never verifies API Y on the same origin with another base", async () => {
    await setBase("/x");
    const codeX = await giveCode(h.seeded.apiId);
    const y = await seedLiveApi(h.sql, h.stub.origin, { state: "endpoints_confirmed", pathPrefix: anotherBase() });
    const [{ path_prefix: yBase }] = await h.sql<{ path_prefix: string }[]>`select path_prefix from apis where id = ${y.apiId}`;
    const codeY = await giveCode(y.apiId);
    expect(codeX).not.toBe(codeY);
    // The origin's root and X's base send X's code; Y's base sends nothing.
    serveRoot({ "x-hirakumi-verify": codeX });
    h.stub.setFile("/x", "", { headers: { "x-hirakumi-verify": codeX } });
    expect((await check(h.seeded.apiId)).body).toMatchObject({ ok: true });
    expect((await check(y.apiId)).body).toMatchObject({ ok: false, reason: "missing", triedUrl: `${h.stub.origin}${yBase}` });
    // Y's own base with X's code is still not Y's code.
    h.stub.setFile(yBase, "", { headers: { "x-hirakumi-verify": codeX } });
    expect((await check(y.apiId)).body).toMatchObject({ ok: false, reason: "mismatch" });
    h.stub.setFile(yBase, "", { headers: { "x-hirakumi-verify": codeY } });
    expect((await check(y.apiId)).body).toMatchObject({ ok: true });
  });

  it("a code is never reused: the database refuses the same code for a second API", async () => {
    const code = await giveCode(h.seeded.apiId);
    const y = await seedLiveApi(h.sql, h.stub.origin, { pathPrefix: anotherBase() });
    await expect(h.sql`insert into challenges (id, api_id, kind, token, expires_at)
                       values (${newId("ch")}, ${y.apiId}, 'header', ${code}, now() + interval '1 year')`).rejects.toThrow(/unique/);
  });

  it("an old code from the OpenAPI file proof is not used", async () => {
    const code = newVerifyCode();
    await h.sql`insert into challenges (id, api_id, kind, token, expires_at)
                values (${newId("ch")}, ${h.seeded.apiId}, 'openapi', ${code}, now() + interval '10 years')`;
    serveRoot({ "x-hirakumi-verify": code });
    expect((await check()).body).toMatchObject({ ok: false, reason: "no_code" });
  });

  it("works for an API given by example requests, which has no openapi_url", async () => {
    const code = await giveCode(h.seeded.apiId);
    await h.sql`update apis set openapi_url = null, intake_kind = 'samples', path_prefix = '/v1',
                samples = ${h.sql.json({ base: `${h.stub.origin}/v1`, lines: "GET /price?symbol=ADA" })} where id = ${h.seeded.apiId}`;
    h.stub.setFile("/v1", "", { status: 404, headers: { "x-hirakumi-verify": code } });
    expect((await check()).body).toMatchObject({ ok: true, triedUrl: `${h.stub.origin}/v1`, status: 404 });
  });

  it("is 404 for an unknown API", async () => {
    expect((await check("api_nope")).status).toBe(404);
  });
});
