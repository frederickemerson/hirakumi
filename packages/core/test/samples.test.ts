import { describe, expect, it } from "vitest";
import { ownershipCheckUrl } from "../src/ownership";
import { normalizeSamplesBase, parseSampleLines, SampleError, schemaOfExample, specFromSamples } from "../src/samples";

// Made up, and split so secret scanners do not read it as a real HubSpot key.
const FAKE_HUBSPOT_KEY = ["pat", "na1", "11111111-2222-3333-4444-555555555555"].join("-");

describe("normalizeSamplesBase", () => {
  it("treats the base as a folder, without a trailing slash", () => {
    expect(normalizeSamplesBase("https://api.example.com/v1")).toEqual({
      base: "https://api.example.com/v1",
      origin: "https://api.example.com",
      hostname: "api.example.com",
    });
    expect(normalizeSamplesBase("https://api.example.com/v1/").base).toBe("https://api.example.com/v1");
    expect(normalizeSamplesBase("https://api.example.com").base).toBe("https://api.example.com");
  });

  it("refuses http, credentials, queries, fragments and ambiguous paths", () => {
    for (const bad of [
      "http://api.example.com", "https://u:p@api.example.com", "https://api.example.com/v1?x=1", "https://api.example.com/v1?",
      "https://api.example.com/#x", "https://api.example.com/a%2fb", "https://api.example.com/a;b", "not a url", "",
    ]) {
      expect(() => normalizeSamplesBase(bad), bad).toThrow(SampleError);
    }
    expect(normalizeSamplesBase("http://localhost:4100", true).origin).toBe("http://localhost:4100");
  });

  it("refuses a host ending in a dot, which would be a second name for the same API", () => {
    for (const bad of ["https://api.example.com./t", "https://api.example.com.", "https://api.example.com.:8443/v1"]) {
      expect(() => normalizeSamplesBase(bad), bad).toThrow(/dot at the end of the host name/);
    }
  });

  it("refuses two slashes in a row, which some servers read as another folder", () => {
    for (const bad of ["https://h.com/a//", "https://h.com//", "https://h.com/a//b"]) {
      expect(() => normalizeSamplesBase(bad), bad).toThrow(/two slashes in a row/);
    }
  });

  it("gives a base the gateway's ownership check accepts as its check URL", () => {
    const { base, origin } = normalizeSamplesBase("https://api.example.com/v1");
    expect(ownershipCheckUrl({ origin, pathPrefix: new URL(base).pathname, code: "hkv_Ab3dEf7hIj9kLm1nOp5qRs2tUv4wXy6zAb8cDe0fGh2" }))
      .toEqual({ ok: true, url: base });
  });
});

describe("parseSampleLines", () => {
  it("reads method, path params, required and optional query params, and a JSON body", () => {
    const s = parseSampleLines(`
      # comment
      /price?symbol=ADA
      get /coins/{id=bitcoin}/history?vs=usd&days?=7
      POST /search {"q": "ada", "limit": 5}
    `);
    expect(s).toEqual([
      { method: "GET", path: "/price", pathParams: [], query: [{ name: "symbol", value: "ADA", required: true }] },
      {
        method: "GET", path: "/coins/{id}/history",
        pathParams: [{ name: "id", value: "bitcoin", required: true }],
        query: [{ name: "vs", value: "usd", required: true }, { name: "days", value: "7", required: false }],
      },
      { method: "POST", path: "/search", pathParams: [], query: [], body: { q: "ada", limit: 5 } },
    ]);
  });

  it("names the line that is wrong", () => {
    const cases: [string, RegExp][] = [
      ["GET price", /Line 1: the path must start/],
      ["/ok\nFETCH /x", /Line 2: "FETCH" is not a method/],
      ["/coins/{id}", /example value for \{id\}/],
      ["/x?symbol", /example value for "symbol"/],
      ["/x?body=1", /reserved/],
      ["/x?a=1&a=2", /appears twice/],
      ["/a/../b", /dot segment/],
      ["/a%2fb", /encoded slash/],
      ["POST /s {nope", /must be JSON/],
      ["GET /s {}", /can't have a body/],
      ["", /at least one/],
    ];
    for (const [text, re] of cases) expect(() => parseSampleLines(text), text).toThrow(re);
    expect(() => parseSampleLines(Array.from({ length: 21 }, () => "/x?a=1").join("\n"))).toThrow(/at most 20/);
  });
});

describe("values the gateway can't send", () => {
  it.each([
    ["GET /x?a=%E0", /Line 1: the value of "a" has a broken % escape/],
    ["/ok\nGET /x/{id=%zz}", /Line 2: the value of \{id\} has a broken % escape/],
    ["GET /x?%zz=1", /Line 1: the query name "%zz" has a broken % escape/],
  ])("refuses a broken %% escape in %j as a SampleError", (text, msg) => {
    expect(() => parseSampleLines(text)).toThrow(SampleError);
    expect(() => parseSampleLines(text)).toThrow(msg);
  });

  it.each(["GET /files/{path=a/b}", "GET /files/{path=a%2Fb}", "GET /files/{path=a%5cb}", "GET /files/{path=a\\b}", "GET /files/{path=.}", "GET /files/{path=..}", "GET /files/{path=%2E%2E}"])(
    "refuses the path value in %j and suggests the query",
    (text) => {
      expect(() => parseSampleLines(text)).toThrow(SampleError);
      expect(() => parseSampleLines(text)).toThrow(/Line 1: the value of \{path\} can't contain \/ or \\ or be \. or \.\. .*Put it in the query instead/);
    },
  );

  it("keeps a path value with dots inside it", () => {
    expect(parseSampleLines("GET /files/{name=a.b..c}")[0].pathParams).toEqual([{ name: "name", value: "a.b..c", required: true }]);
  });
});

describe("a key in the example requests", () => {
  // Every value becomes a public input example for buyers and the lines are stored as typed, so a key is refused.
  it.each([
    ["GET /price?symbol=ADA&apikey=a1b2c3d4e5f6g7h8i9j0", /"apikey" looks like your API's key/],
    ["GET /price?symbol=ADA&api_key=YOUR_KEY", /"api_key" looks like your API's key/],
    ["GET /items/{key=abc}", /"key" looks like your API's key/],
    ["GET /price?symbol=ADA&k=sk_live_abcdefghijkl1234", /looks like it has a key, token or password/],
    ['POST /search {"q": "ada", "api_key": "a1b2c3d4e5f6g7h8"}', /looks like it has a key, token or password/],
    // Key names from real APIs.
    ["GET /simple/price?ids=cardano&x_cg_demo_api_key=CG-q1W2e3R4t5Y6u7I8o9P0aSdF", /"x_cg_demo_api_key" looks like your API's key/],
    ["GET /v1/cryptocurrency/listings/latest?CMC_PRO_API_KEY=3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b", /"CMC_PRO_API_KEY" looks like your API's key/],
    ["GET /v2/translate?text=hi&auth_key=3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b:fx", /"auth_key" looks like your API's key/],
    ["GET /x?subscription-key=0123456789abcdef0123456789abcdef", /"subscription-key" looks like your API's key/],
    [`GET /contacts?hapikey=${FAKE_HUBSPOT_KEY}`, /"hapikey" looks like your API's key/],
    ["GET /x?x-api-token=a1b2c3d4e5f6g7h8", /"x-api-token" looks like your API's key/],
    ["GET /x?token=sk_live_abcdefghijkl1234", /looks like it has a key, token or password/],
  ])("refuses %j and says where the key goes", (line, msg) => {
    expect(() => parseSampleLines(line)).toThrow(SampleError);
    expect(() => parseSampleLines(line)).toThrow(msg);
    expect(() => parseSampleLines(line)).toThrow(/add the key on the ownership page/);
  });

  it("keeps ordinary crypto inputs named token or signature", () => {
    const [s] = parseSampleLines("GET /quote?token=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&signature=abcdef123456");
    expect(s.query.map((q) => q.name)).toEqual(["token", "signature"]);
  });

  it.each([
    "GET /asset/{unit=1d7f33bd23d85e1a25d87d86fac4f199c3197a2f7afeb662a0f34e1e.776f726c646d6f62696c65746f6b656e}?token=1d7f33bd23d85e1a25d87d86fac4f199c3197a2f7afeb662a0f34e1e.776f726c646d6f62696c65746f6b656e",
    "GET /price?token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "GET /balance?token=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    "GET /utxos?token=addr_test1vrgvs0dkrtnm4uxpq5fu4e5gm0jvqhp6xlyq6dnwvzk0cqs5yhtyn&sig=0x5e1a3b9c0d7f2e4a6b8c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e0f1a2b",
    "GET /search?keyword=ada&keys=a,b&sort_key=price&public_key=ed25519pk1x2y3z4",
  ])("keeps on-chain ids and ordinary names: %j", (line) => {
    expect(() => parseSampleLines(line)).not.toThrow();
  });
});

describe("specFromSamples", () => {
  it("builds one operation per method and path, with typed examples", () => {
    const samples = parseSampleLines("/price?symbol=ADA&limit=5\n/price?symbol=BTC&limit=2.5\n/coins/{id=007}?live?=true");
    const spec = specFromSamples({ title: "Prices", base: "https://api.example.com/v1", samples });
    expect(spec.servers).toEqual([{ url: "https://api.example.com/v1" }]);
    const paths = spec.paths as Record<string, Record<string, { parameters: unknown[] }>>;
    expect(paths["/price"].get.parameters).toEqual([
      { name: "symbol", in: "query", required: true, schema: { type: "string", examples: ["ADA", "BTC"] } },
      { name: "limit", in: "query", required: true, schema: { type: "number", examples: [5, 2.5] } },
    ]);
    // "007" is not an exact integer, so it stays a string (the value is sent unchanged).
    expect(paths["/coins/{id}"].get.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string", examples: ["007"] } },
      { name: "live", in: "query", required: false, schema: { type: "boolean", examples: [true] } },
    ]);
  });

  it("makes a parameter optional when a line leaves it out", () => {
    const spec = specFromSamples({ title: "t", base: "https://h.com", samples: parseSampleLines("/p?a=1&b=x\n/p?a=2") });
    const params = (spec.paths as Record<string, Record<string, { parameters: { name: string; required: boolean }[] }>>)["/p"].get.parameters;
    expect(params.map((p) => [p.name, p.required])).toEqual([["a", true], ["b", false]]);
  });

});

describe("schemaOfExample", () => {
  it("infers nested shapes", () => {
    expect(schemaOfExample({ q: "a", n: 1, f: 1.5, tags: ["x"], o: { b: true }, z: null })).toEqual({
      type: "object",
      properties: {
        q: { type: "string" }, n: { type: "integer" }, f: { type: "number" },
        tags: { type: "array", items: { type: "string" } }, o: { type: "object", properties: { b: { type: "boolean" } }, required: ["b"] },
        z: { type: "null" },
      },
      required: ["q", "n", "f", "tags", "o", "z"],
    });
  });
});
