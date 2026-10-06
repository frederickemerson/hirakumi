import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { newId, newVerifyCode } from "@hirakumi/core";
import { makeHarness, seedLiveApi, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });
const auth = () => ({ authorization: `Bearer ${h.config.internalToken}` });

async function giveCode(apiId: string): Promise<string> {
  const code = newVerifyCode();
  await h.sql`insert into challenges (id, api_id, kind, token, expires_at)
              values (${newId("ch")}, ${apiId}, 'openapi', ${code}, now() + interval '10 years')`;
  return code;
}
const check = (apiId = h.seeded.apiId) => request(h.app).post(`/internal/challenge/${apiId}/check`).set(auth());
const specJson = (extra: Record<string, unknown> = {}, servers: unknown = [{ url: h.stub.origin }]) =>
  JSON.stringify({ openapi: "3.1.0", info: { title: "Price", version: "1" }, servers, paths: {}, ...extra });

describe("ownership check: x-hirakumi-verify in the OpenAPI file", () => {
  it("passes when the root field matches (JSON) and leaves the code for the web app to consume", async () => {
    const code = await giveCode(h.seeded.apiId);
    h.stub.setFile("/openapi.json", specJson({ "x-hirakumi-verify": code }));
    const ok = await check();
    expect(ok.body).toEqual({ ok: true, reason: "verified", triedUrl: `${h.stub.origin}/openapi.json`, detail: "Found your code. The OpenAPI file is verified." });
    const [row] = await h.sql<{ consumed_at: Date | null; proof: unknown }[]>`select consumed_at, proof from challenges`;
    expect(row.consumed_at).toBeNull();
    expect(row.proof).toBeNull();
    expect((await check()).body.ok).toBe(true);
  });

  it("passes for a YAML file", async () => {
    const code = await giveCode(h.seeded.apiId);
    await h.sql`update apis set openapi_url = ${`${h.stub.origin}/openapi.yaml`} where id = ${h.seeded.apiId}`;
    h.stub.setFile("/openapi.yaml", `openapi: 3.1.0\ninfo:\n  title: Price\n  version: "1"\nx-hirakumi-verify: "${code}"\nservers:\n  - url: ${h.stub.origin}\npaths: {}\n`,
      { contentType: "application/yaml" });
    expect((await check()).body).toMatchObject({ ok: true, reason: "verified" });
  });

  it("says when the field is missing", async () => {
    await giveCode(h.seeded.apiId);
    h.stub.setFile("/openapi.json", specJson());
    const r = (await check()).body;
    expect(r).toMatchObject({ ok: false, reason: "missing", triedUrl: `${h.stub.origin}/openapi.json` });
    expect(r.detail).toMatch(/no x-hirakumi-verify field at the root/);
  });

  it("says when the code is wrong", async () => {
    await giveCode(h.seeded.apiId);
    h.stub.setFile("/openapi.json", specJson({ "x-hirakumi-verify": "hkv_not-the-code" }));
    const r = (await check()).body;
    expect(r).toMatchObject({ ok: false, reason: "mismatch" });
    expect(r.detail).toMatch(/does not match this API's code/);
  });

  it("verifying API Y never verifies API X on the same origin, and X's spec with Y's code fails", async () => {
    const codeX = await giveCode(h.seeded.apiId);
    const y = await seedLiveApi(h.sql, h.stub.origin, { state: "endpoints_confirmed" });
    const codeY = await giveCode(y.apiId);
    expect(codeX).not.toBe(codeY);
    h.stub.setFile("/openapi.json", specJson({ "x-hirakumi-verify": codeY }));
    expect((await check(y.apiId)).body).toMatchObject({ ok: true });
    expect((await check(h.seeded.apiId)).body).toMatchObject({ ok: false, reason: "mismatch" });
  });

  it("a code is never reused: the database refuses the same code for a second API", async () => {
    const code = await giveCode(h.seeded.apiId);
    const y = await seedLiveApi(h.sql, h.stub.origin);
    await expect(h.sql`insert into challenges (id, api_id, kind, token, expires_at)
                       values (${newId("ch")}, ${y.apiId}, 'openapi', ${code}, now() + interval '1 year')`).rejects.toThrow(/unique/);
  });

  it("says when there is no code for this API", async () => {
    h.stub.setFile("/openapi.json", specJson({ "x-hirakumi-verify": "hkv_x" }));
    expect((await check()).body).toMatchObject({ ok: false, reason: "no_code" });
  });

  it("reports the status when the file cannot be fetched", async () => {
    await giveCode(h.seeded.apiId);
    const r = (await check()).body;
    expect(r).toMatchObject({ ok: false, reason: "http_status", status: 404 });
    expect(r.detail).toMatch(/answered 404/);
  });

  it("refuses a redirect, even to a file with the right code", async () => {
    const code = await giveCode(h.seeded.apiId);
    h.stub.setFile("/real.json", specJson({ "x-hirakumi-verify": code }));
    h.stub.setFile("/openapi.json", "", { status: 302, headers: { location: `${h.stub.origin}/real.json` } });
    const r = (await check()).body;
    expect(r).toMatchObject({ ok: false, reason: "redirect", status: 302 });
    expect(r.detail).toMatch(/does not follow redirects/);
    expect(h.stub.fileHits("/real.json")).toBe(0);
  });

  it("says when the file is not JSON or YAML", async () => {
    await giveCode(h.seeded.apiId);
    h.stub.setFile("/openapi.json", "<html><body>hello</body></html>", { contentType: "text/html" });
    expect((await check()).body).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("refuses a spec on another origin than the API, without fetching it", async () => {
    const code = await giveCode(h.seeded.apiId);
    const other = h.stub.origin.replace("127.0.0.1", "localhost");
    await h.sql`update apis set openapi_url = ${`${other}/openapi.json`} where id = ${h.seeded.apiId}`;
    h.stub.setFile("/openapi.json", specJson({ "x-hirakumi-verify": code }));
    expect((await check()).body).toMatchObject({ ok: false, reason: "origin_mismatch" });
    expect(h.stub.fileHits("/openapi.json")).toBe(0);
  });

  it("refuses a spec whose servers[0] now points to another origin", async () => {
    const code = await giveCode(h.seeded.apiId);
    h.stub.setFile("/openapi.json", specJson({ "x-hirakumi-verify": code }, [{ url: "https://victim.example" }]));
    expect((await check()).body).toMatchObject({ ok: false, reason: "origin_mismatch" });
  });

  describe("directory binding", () => {
    it("a spec in /team-a/ verifies an API whose base is /team-a", async () => {
      const code = await giveCode(h.seeded.apiId);
      await h.sql`update apis set openapi_url = ${`${h.stub.origin}/team-a/openapi.json`}, path_prefix = '/team-a' where id = ${h.seeded.apiId}`;
      h.stub.setFile("/team-a/openapi.json", specJson({ "x-hirakumi-verify": code }, [{ url: `${h.stub.origin}/team-a` }]));
      expect((await check()).body).toMatchObject({ ok: true });
    });

    it("a spec in /team-a/ cannot verify an API at the root, without fetching it", async () => {
      const code = await giveCode(h.seeded.apiId);
      await h.sql`update apis set openapi_url = ${`${h.stub.origin}/team-a/openapi.json`}, path_prefix = '/' where id = ${h.seeded.apiId}`;
      h.stub.setFile("/team-a/openapi.json", specJson({ "x-hirakumi-verify": code }));
      const r = (await check()).body;
      expect(r).toMatchObject({ ok: false, reason: "outside_directory" });
      expect(r.detail).toMatch(/only prove ownership of APIs under \/team-a\//);
      expect(h.stub.fileHits("/team-a/openapi.json")).toBe(0);
    });

    it("a spec in /team-a/ cannot verify an API in /team-b", async () => {
      const code = await giveCode(h.seeded.apiId);
      await h.sql`update apis set openapi_url = ${`${h.stub.origin}/team-a/openapi.json`}, path_prefix = '/team-b' where id = ${h.seeded.apiId}`;
      h.stub.setFile("/team-a/openapi.json", specJson({ "x-hirakumi-verify": code }, [{ url: `${h.stub.origin}/team-b` }]));
      expect((await check()).body).toMatchObject({ ok: false, reason: "outside_directory" });
    });

    it("re-checks the spec's current servers[0] against the directory", async () => {
      const code = await giveCode(h.seeded.apiId);
      await h.sql`update apis set openapi_url = ${`${h.stub.origin}/team-a/openapi.json`}, path_prefix = '/team-a' where id = ${h.seeded.apiId}`;
      h.stub.setFile("/team-a/openapi.json", specJson({ "x-hirakumi-verify": code }, [{ url: "/" }]));
      expect((await check()).body).toMatchObject({ ok: false, reason: "outside_directory" });
    });
  });
});
