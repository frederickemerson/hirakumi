import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { ADMIN, makeApp } from "./helpers.js";
import { buildOpenApi } from "../src/openapi.js";
import { parseChallenges } from "../src/challenge.js";

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

  it("declares no side effects (GET only, no requestBody)", () => {
    const doc = buildOpenApi("https://x") as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.paths)).toEqual(["/price"]);
    expect(Object.keys(doc.paths["/price"])).toEqual(["get"]);
  });
});

describe("ownership challenge", () => {
  const challenges = { api_abc123: "hk-challenge-token-xyz" };

  it("serves the token byte-exact as text/plain", async () => {
    const res = await request(makeApp({ challenges })).get("/.well-known/hirakumi/api_abc123.txt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.text).toBe("hk-challenge-token-xyz");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("the seller can upload a challenge file through the admin API (demo stand-in for uploading it to their server)", async () => {
    const app = makeApp({ challenges: {} });
    const auth = { authorization: `Bearer ${ADMIN}` };
    expect((await request(app).put("/admin/challenge/api_new1").set(auth).type("text/plain").send("tok-123")).status).toBe(204);
    const got = await request(app).get("/.well-known/hirakumi/api_new1.txt");
    expect(got.status).toBe(200);
    expect(got.text).toBe("tok-123");
    expect((await request(app).put("/admin/challenge/api_new1").type("text/plain").send("x")).status).toBe(401);
    expect((await request(app).put("/admin/challenge/__proto__").set(auth).type("text/plain").send("x")).status).toBe(400);
    expect((await request(app).put("/admin/challenge/api_new2").set(auth).type("text/plain").send("")).status).toBe(400);
  });

  it("404s for unknown ids and non-api names", async () => {
    const app = makeApp({ challenges });
    expect((await request(app).get("/.well-known/hirakumi/api_other.txt")).status).toBe(404);
    expect((await request(app).get("/.well-known/hirakumi/__proto__.txt")).status).toBe(404);
    expect((await request(app).get("/.well-known/hirakumi/api_abc123.json")).status).toBe(404);
  });

  it("parses HIRAKUMI_CHALLENGE JSON and ignores bad entries", () => {
    const log = vi.fn();
    expect(parseChallenges('{"api_a1":"t1","bad key":"t2","api_b2":5}', log)).toEqual({ api_a1: "t1" });
    expect(parseChallenges(undefined, log)).toEqual({});
  });

  it("logs and serves nothing when HIRAKUMI_CHALLENGE is not JSON", () => {
    const log = vi.fn();
    expect(parseChallenges("api_a1=t1", log)).toEqual({});
    expect(log).toHaveBeenCalledOnce();
  });
});
