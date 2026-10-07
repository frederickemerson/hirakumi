import { describe, expect, it } from "vitest";
import { PermanentError } from "../src/errors.js";
import { describeAuthHint, OpenApiError, parseOpenApi, toOpId } from "../src/openapi/parse.js";
import { PRICE_SPEC } from "./fixtures.js";

describe("parseOpenApi", () => {
  it("lists sellable operations with JSON-Schema inputs and explains skipped ones", async () => {
    const r = await parseOpenApi(PRICE_SPEC);
    expect(r.title).toBe("Price API");
    expect(r.operations.map((o) => [o.opId, o.method, o.path])).toEqual([
      ["getPrice", "GET", "/price"],
      ["get_history_symbol", "GET", "/history/{symbol}"],
      ["createAlert", "POST", "/alerts"],
    ]);
    expect(r.operations[0].inputSchema).toEqual({
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker", examples: ["ADA"] } },
      required: ["symbol"],
      additionalProperties: false,
    });
    expect(r.operations[1].inputSchema.required).toEqual(["symbol"]);
    expect(r.operations[2].inputSchema.properties.body).toMatchObject({ examples: [{ symbol: "ADA" }] });
    expect(r.operations[0].llm).toMatchObject({ opId: "getPrice", summary: "Current price for a symbol" });
    expect(r.skipped).toEqual([
      { method: "GET", path: "/me", reason: "needs HTTP basic sign-in (not supported yet)" },
      { method: "POST", path: "/upload", reason: "request body is not JSON (not supported yet)" },
      { method: "GET", path: "/ext", reason: "uses a circular or external schema reference (not supported yet)" },
    ]);
  });

  it("names the line of a YAML syntax error", async () => {
    await expect(parseOpenApi("openapi: 3.0.3\ninfo:\n  title: [x\n")).rejects.toThrow(/could not be read: .*line \d+/);
  });

  it("asks for 3.x when given Swagger 2.0, as a permanent error", async () => {
    const p = parseOpenApi(JSON.stringify({ swagger: "2.0", info: { title: "t", version: "1" }, paths: {} }));
    await expect(p).rejects.toBeInstanceOf(OpenApiError);
    await expect(p).rejects.toBeInstanceOf(PermanentError);
    await expect(p).rejects.toThrow(/Swagger 2\.0/);
  });

  it("rejects an invalid 3.x document with the validator's reason", async () => {
    const bad = JSON.stringify({ openapi: "3.0.3", info: { title: "t", version: "1" }, paths: { "/x": { get: { responses: {} } } } });
    await expect(parseOpenApi(bad)).rejects.toThrow(/not valid: .*responses/);
  });
});

describe("toOpId", () => {
  it("keeps safe operationIds and slugs everything else", () => {
    expect(toOpId("getPrice", "GET", "/price")).toBe("getPrice");
    expect(toOpId("get price/now", "GET", "/p")).toBe("get_price_now");
    expect(toOpId(undefined, "GET", "/history/{symbol}")).toBe("get_history_symbol");
  });
});

describe("parseOpenApi: paths that leave the proven folder (audit C1)", () => {
  const spec = (paths: string[]) =>
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Attacker", version: "1" },
      servers: [{ url: "/~attacker" }],
      paths: Object.fromEntries(
        ["/ok", ...paths].map((p) => [p, { get: { operationId: `op${Math.random().toString(36).slice(2)}`, responses: { "200": { description: "ok" } } } }]),
      ),
    });

  it.each([
    "/../~victim/data",
    "/%2e%2e/~victim/data",
    "/%2E%2E/~victim/data",
    "/.%2e/~victim/data",
    "/a/./b",
    "/a/%2E/b",
    "/a;b",
    "/a\\..\\b",
    "/a%2fb",
    "/a%2F..%2Fb",
    "/a%5cb",
  ])("skips %j and says why", async (path) => {
    const r = await parseOpenApi(spec([path]));
    expect(r.operations.map((o) => o.path)).toEqual(["/ok"]);
    expect(r.skipped).toEqual([{ method: "GET", path, reason: expect.stringMatching(/^its path has (a dot segment|a ';'|a backslash|an encoded slash)/) }]);
  });

  it("keeps ordinary paths with dots inside a segment", async () => {
    const r = await parseOpenApi(spec(["/v1.2/data.json", "/files/{name}", "/a..b"]));
    expect(r.operations.map((o) => o.path)).toEqual(["/ok", "/v1.2/data.json", "/files/{name}", "/a..b"]);
    expect(r.skipped).toEqual([]);
  });
});

describe("parseOpenApi: APIs that need a key", () => {
  const spec = (o: { schemes: Record<string, unknown>; security?: unknown; paths: Record<string, Record<string, unknown>> }) =>
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Keyed", version: "1" },
      ...(o.security ? { security: o.security } : {}),
      paths: Object.fromEntries(Object.entries(o.paths).map(([p, op]) => [p, { get: { responses: { "200": { description: "ok" } }, ...op } }])),
      components: { securitySchemes: o.schemes },
    });

  it("sells operations that need an apiKey header and says where the key goes", async () => {
    const r = await parseOpenApi(spec({
      schemes: { key: { type: "apiKey", in: "header", name: "X-API-Key" } },
      security: [{ key: [] }],
      paths: {
        "/price": { parameters: [{ name: "x-api-key", in: "header", required: true, schema: { type: "string" } }, { name: "symbol", in: "query", required: true, schema: { type: "string" } }] },
        "/open": { security: [] },
      },
    }));
    expect(r.authHint).toEqual({ in: "header", name: "X-API-Key" });
    expect(r.skipped).toEqual([]);
    expect(r.operations.map((o) => [o.path, o.needsKey])).toEqual([["/price", true], ["/open", false]]);
    // The key header is the gateway's to add, never a buyer input.
    expect(r.operations[0].inputSchema.required).toEqual(["symbol"]);
    expect(r.operations[0].llm.parameters.map((p) => p.name)).toEqual(["symbol"]);
  });

  describe("two keys at once (follow-up B, UPSTREAM_AUTH_V3)", () => {
    const supabase = {
      schemes: { apikey: { type: "apiKey", in: "header", name: "apikey" }, jwt: { type: "http", scheme: "bearer" } },
      security: [{ apikey: [], jwt: [] }],
      paths: {
        "/rest": { parameters: [{ name: "apikey", in: "header", required: true, schema: { type: "string" } }, { name: "q", in: "query", schema: { type: "string" } }] },
      },
    };

    it("are skipped while keys in several parts can't be saved", async () => {
      const r = await parseOpenApi(spec(supabase));
      expect(r.operations).toEqual([]);
      expect(r.skipped[0].reason).toBe("needs two or more keys at once (not supported yet)");
    });

    it("are sold as a key in several parts: the hint lists every part, and no part is a buyer input", async () => {
      const r = await parseOpenApi(spec(supabase), { multiPartKeys: true });
      expect(r.skipped).toEqual([]);
      expect(r.authHint).toEqual({
        in: "header", name: "apikey",
        parts: [{ in: "header", name: "apikey" }, { in: "header", name: "Authorization", prefix: "Bearer " }],
      });
      expect(r.operations[0].needsKey).toBe(true);
      expect(Object.keys(r.operations[0].inputSchema.properties)).toEqual(["q"]);
      expect(describeAuthHint(r.authHint!)).toBe("the apikey header and a bearer token in the Authorization header");
    });

    it("a header and a query key at once; the same requirement in another order is the same key", async () => {
      const r = await parseOpenApi(spec({
        schemes: { app: { type: "apiKey", in: "header", name: "X-App-Id" }, key: { type: "apiKey", in: "query", name: "key" } },
        paths: { "/a": { security: [{ app: [], key: [] }] }, "/b": { security: [{ key: [], app: [] }] } },
      }), { multiPartKeys: true });
      expect(r.skipped).toEqual([]);
      expect(r.authHint?.parts).toEqual([{ in: "header", name: "X-App-Id" }, { in: "query", name: "key" }]);
      expect(r.operations.map((o) => o.needsKey)).toEqual([true, true]);
    });

    it("skips what no key form preset can send: two query keys, three headers, a part Hirakumi can't supply", async () => {
      const r = await parseOpenApi(spec({
        schemes: {
          q1: { type: "apiKey", in: "query", name: "a" }, q2: { type: "apiKey", in: "query", name: "b" },
          h1: { type: "apiKey", in: "header", name: "X-A" }, h2: { type: "apiKey", in: "header", name: "X-B" }, h3: { type: "apiKey", in: "header", name: "X-C" },
          basic: { type: "http", scheme: "basic" },
        },
        paths: {
          "/qq": { security: [{ q1: [], q2: [] }] },
          "/hhh": { security: [{ h1: [], h2: [], h3: [] }] },
          "/hb": { security: [{ h1: [], basic: [] }] },
        },
      }), { multiPartKeys: true });
      expect(r.operations).toEqual([]);
      expect(r.skipped.map((s) => s.reason)).toEqual([
        "needs 2 query keys at once (not supported yet)",
        "needs 3 header keys at once (not supported yet)",
        "needs HTTP basic sign-in (not supported yet)",
      ]);
    });
  });

  it("maps http bearer to the Authorization header with a Bearer prefix", async () => {
    const r = await parseOpenApi(spec({ schemes: { jwt: { type: "http", scheme: "bearer" } }, paths: { "/me": { security: [{ jwt: [] }] } } }));
    expect(r.authHint).toEqual({ in: "header", name: "Authorization", prefix: "Bearer " });
    expect(r.operations[0].needsKey).toBe(true);
  });

  it("drops a query key parameter from the inputs", async () => {
    const r = await parseOpenApi(spec({
      schemes: { q: { type: "apiKey", in: "query", name: "api_key" } },
      security: [{ q: [] }],
      paths: { "/p": { parameters: [{ name: "api_key", in: "query", required: true, schema: { type: "string" } }] } },
    }));
    expect(r.authHint).toEqual({ in: "query", name: "api_key" });
    expect(r.operations[0].inputSchema).toMatchObject({ properties: {}, required: [] });
  });

  it("treats optional security ({}) as no key, and an API with no secured operation has no hint", async () => {
    const r = await parseOpenApi(spec({ schemes: { key: { type: "apiKey", in: "header", name: "X-Key" } }, security: [{ key: [] }, {}], paths: { "/p": {} } }));
    expect(r.authHint).toBeNull();
    expect(r.operations[0].needsKey).toBe(false);
  });

  it("skips schemes Hirakumi can't supply, each with a clear reason", async () => {
    const r = await parseOpenApi(spec({
      schemes: {
        basic: { type: "http", scheme: "basic" },
        oauth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://x.example/token", scopes: {} } } },
        oidc: { type: "openIdConnect", openIdConnectUrl: "https://x.example/.well-known/openid-configuration" },
        cookie: { type: "apiKey", in: "cookie", name: "sid" },
        host: { type: "apiKey", in: "header", name: "Host" },
        a: { type: "apiKey", in: "header", name: "X-A" },
        b: { type: "apiKey", in: "header", name: "X-B" },
      },
      paths: {
        "/basic": { security: [{ basic: [] }] },
        "/oauth": { security: [{ oauth: [] }] },
        "/oidc": { security: [{ oidc: [] }] },
        "/cookie": { security: [{ cookie: [] }] },
        "/host": { security: [{ host: [] }] },
        "/both": { security: [{ a: [], b: [] }] },
      },
    }));
    expect(r.operations).toEqual([]);
    expect(r.authHint).toBeNull();
    expect(r.skipped.map((s) => [s.path, s.reason])).toEqual([
      ["/basic", "needs HTTP basic sign-in (not supported yet)"],
      ["/oauth", "needs OAuth 2 sign-in (not supported yet)"],
      ["/oidc", "needs OpenID Connect sign-in (not supported yet)"],
      ["/cookie", "needs a key in a cookie (not supported yet)"],
      ["/host", expect.stringMatching(/^needs a key Hirakumi can't send: Hirakumi sets the Host header itself/)],
      ["/both", "needs two or more keys at once (not supported yet)"],
    ]);
  });

  it("keeps the key most operations use and skips operations that need a different one", async () => {
    const r = await parseOpenApi(spec({
      schemes: { a: { type: "apiKey", in: "header", name: "X-A" }, b: { type: "apiKey", in: "query", name: "b_key" }, jwt: { type: "http", scheme: "bearer" } },
      paths: {
        "/one": { security: [{ b: [] }] },
        "/two": { security: [{ a: [] }] },
        "/three": { security: [{ jwt: [] }, { a: [] }] },
      },
    }));
    expect(r.authHint).toEqual({ in: "header", name: "X-A" });
    expect(r.operations.map((o) => o.path)).toEqual(["/two", "/three"]);
    expect(r.skipped).toEqual([
      { method: "GET", path: "/one", reason: "needs a different key (the b_key query parameter) than your other endpoints, and Hirakumi keeps one key per API" },
    ]);
  });
});
