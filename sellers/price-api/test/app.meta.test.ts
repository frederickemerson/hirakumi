import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { ADMIN, makeApp } from "./helpers.js";
import { buildOpenApi } from "../src/openapi.js";
import { latestCode, parseChallenges } from "../src/challenge.js";

describe("openapi.json", () => {
  it("is OpenAPI 3.1 with getPrice, examples and a response schema", async () => {
    const res = await request(makeApp()).get("/openapi.json");
    expect(res.status).toBe(200);
    const doc = res.body;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://price.test");
    const op = doc.paths["/price"].get;
    expect(op.operationId).toBe("getPrice");
    const param = op.parameters[0];
    expect(param).toMatchObject({ name: "symbol", in: "query", required: true, example: "ADA" });
    expect(param.schema.enum).toEqual(["ADA", "BTC", "ETH", "SOL"]);
    const ok = op.responses["200"].content["application/json"];
    expect(ok.schema.$ref).toBe("#/components/schemas/Price");
    const schema = doc.components.schemas.Price;
    expect(schema.required).toEqual(["symbol", "usd", "change24h", "timestamp"]);
    const example = ok.examples.ada.value;
    for (const key of schema.required) expect(example).toHaveProperty(key);
    expect(op.responses["400"]).toBeDefined();
  });

  it("names the API from its title, so a second copy can be listed under its own name", () => {
    expect((buildOpenApi("https://x") as { info: { title: string } }).info.title).toBe("Hirakumi Demo Price API");
    expect((buildOpenApi("https://x", "Mika's Crypto Prices") as { info: { title: string } }).info.title).toBe("Mika's Crypto Prices");
  });

  it("declares no side effects (GET only, no requestBody)", () => {
    const doc = buildOpenApi("https://x") as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.paths)).toEqual(["/price"]);
    expect(Object.keys(doc.paths["/price"])).toEqual(["get"]);
  });
});

describe("ownership: the X-Hirakumi-Verify header on every answer", () => {
  const auth = { authorization: `Bearer ${ADMIN}` };
  const failing = { async get(): Promise<never> { throw new Error("boom"); } };

  it("sends no header until a code is set, has no /.well-known file, and the spec has no field", async () => {
    const app = makeApp({ verifyCodes: {} });
    const res = await request(app).get("/openapi.json");
    expect(res.headers).not.toHaveProperty("x-hirakumi-verify");
    expect(res.body).not.toHaveProperty("x-hirakumi-verify");
    expect((await request(app).get("/.well-known/hirakumi/api_abc123.txt")).status).toBe(404);
  });

  it("sends the code from HIRAKUMI_CHALLENGE on the spec, the price, a 404, a 400, a 500 and admin routes", async () => {
    const app = makeApp({ verifyCodes: { api_abc123: "hkv_one" }, prices: failing });
    const answers = [
      await request(app).get("/openapi.json"),
      await request(makeApp({ verifyCodes: { api_abc123: "hkv_one" } })).get("/price?symbol=ADA"),
      await request(app).get("/"),
      await request(app).get("/no/such/path?x=1"),
      await request(app).get("/price?symbol=NOPE"),
      await request(app).get("/price?symbol=ADA"),
      await request(app).get("/admin/break"),
      await request(app).get("/healthz"),
    ];
    expect(answers.map((r) => r.status)).toEqual([200, 200, 404, 404, 400, 500, 401, 200]);
    for (const r of answers) expect(r.headers["x-hirakumi-verify"]).toBe("hkv_one");
    expect(answers[0].body).not.toHaveProperty("x-hirakumi-verify");
    expect(answers[0].headers["cache-control"]).toBe("no-store");
  });

  it("the admin route sets a code; the latest one set is sent (one header carries one code)", async () => {
    const app = makeApp({ verifyCodes: { api_old1: "hkv_old" } });
    const put = (id: string, code: string) => request(app).put(`/admin/challenge/${id}`).set(auth).type("text/plain").send(code);
    const served = async () => (await request(app).get("/")).headers["x-hirakumi-verify"];
    expect(await served()).toBe("hkv_old");
    expect((await put("api_new1", "hkv_new1")).status).toBe(204);
    expect(await served()).toBe("hkv_new1");
    expect((await put("api_new2", "hkv_new2")).status).toBe(204);
    expect(await served()).toBe("hkv_new2");
    // Setting an older API's code again makes it the latest.
    expect((await put("api_new1", "hkv_new1")).status).toBe(204);
    expect(await served()).toBe("hkv_new1");
  });

  it("the admin route needs the token and a valid api id and code", async () => {
    const app = makeApp({ verifyCodes: {} });
    expect((await request(app).put("/admin/challenge/api_new1").type("text/plain").send("x")).status).toBe(401);
    expect((await request(app).put("/admin/challenge/__proto__").set(auth).type("text/plain").send("x")).status).toBe(400);
    expect((await request(app).put("/admin/challenge/api_new2").set(auth).type("text/plain").send("")).status).toBe(400);
    expect((await request(app).get("/")).headers).not.toHaveProperty("x-hirakumi-verify");
  });

  it("parses HIRAKUMI_CHALLENGE JSON, ignores bad entries, and the last entry is the latest", () => {
    const log = vi.fn();
    const codes = parseChallenges('{"api_a1":"t1","bad key":"t2","api_b2":5,"api_c3":"t3"}', log);
    expect(codes).toEqual({ api_a1: "t1", api_c3: "t3" });
    expect(latestCode(codes)).toBe("t3");
    expect(latestCode({})).toBeNull();
    expect(parseChallenges(undefined, log)).toEqual({});
  });

  it("logs and serves nothing when HIRAKUMI_CHALLENGE is not JSON", () => {
    const log = vi.fn();
    expect(parseChallenges("api_a1=t1", log)).toEqual({});
    expect(log).toHaveBeenCalledOnce();
  });
});

