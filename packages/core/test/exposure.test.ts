import { describe, expect, it } from "vitest";
import { classifyExposure, combineExposure, PROTECTED_STATUSES, type Exposure } from "../src/exposure";
import type { UpstreamResult } from "../src/fetch";
import { compileRule } from "../src/rules";
import { acceptFor, buildUpstreamRequest } from "../src/upstreamRequest";

const rule = compileRule({
  version: 1,
  status: { min: 200, max: 299 },
  contentType: "application/json",
  schema: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
});
const res = (status: number, body: unknown = { price: 1 }, contentType = "application/json"): UpstreamResult => ({
  status, contentType, body: typeof body === "string" ? body : JSON.stringify(body), latencyMs: 3,
});

describe("classifyExposure", () => {
  it("is open when an answer without the key passes the promise", () => {
    expect(classifyExposure(res(200), rule)).toBe("open");
    expect(classifyExposure(res(203), rule)).toBe("open");
  });

  it("is open for any 2xx when the endpoint has no promise yet", () => {
    expect(classifyExposure(res(200, "<html>login</html>", "text/html"), null)).toBe("open");
  });

  it("is protected for 401, 402, 403 and 407", () => {
    for (const status of PROTECTED_STATUSES) expect(classifyExposure(res(status, { error: "key" }), rule)).toBe("protected");
    expect([...PROTECTED_STATUSES]).toEqual([401, 402, 403, 407]);
  });

  it("is protected when a 2xx fails the promise: a login page or an error sent with 200 is not a free good answer", () => {
    expect(classifyExposure(res(200, "<html>sign in</html>", "text/html"), rule)).toBe("protected");
    expect(classifyExposure(res(200, { error: "missing api key" }), rule)).toBe("protected");
  });

  it("is protected for other definite 4xx answers, such as 400 'missing key' or 404", () => {
    expect(classifyExposure(res(400, { error: "missing api key" }), rule)).toBe("protected");
    expect(classifyExposure(res(404, "not found", "text/plain"), rule)).toBe("protected");
  });

  it("is unknown when nothing settles it: no answer, 408, 429, 5xx or 3xx", () => {
    expect(classifyExposure(null, rule)).toBe("unknown");
    for (const status of [408, 429, 500, 502, 503, 301, 302]) expect(classifyExposure(res(status), rule)).toBe("unknown");
  });

  it("does not trust a 5xx body that happens to look like a good answer", () => {
    expect(classifyExposure(res(500, { price: 1 }), null)).toBe("unknown");
  });
});

describe("combineExposure", () => {
  const cases: [Exposure[], Exposure][] = [
    [["protected", "protected"], "protected"],
    [["protected", "open"], "open"],
    [["unknown", "open"], "open"],
    [["protected", "unknown"], "unknown"],
    [[], "unknown"],
  ];
  it.each(cases)("%j is %s", (results, expected) => {
    expect(combineExposure(results)).toBe(expected);
  });
});

describe("buildUpstreamRequest without a key (the leak check)", () => {
  it("builds the same URL and headers as a paid call, minus the key", () => {
    const api = { origin: "https://api.example.com", path_prefix: "/v1" };
    const req = buildUpstreamRequest(api, { method: "get", path: "/price/{symbol}" }, { symbol: "ADA", currency: "usd" }, "application/json");
    expect(req).toEqual({
      url: "https://api.example.com/v1/price/ADA?currency=usd",
      init: { method: "GET", headers: { accept: "application/json", "user-agent": "hirakumi-gateway/0.1" } },
    });
    const keyed = buildUpstreamRequest({ ...api, credential: { in: "header", name: "X-Key", value: "secret-value-1" } }, { method: "GET", path: "/p" }, {});
    expect(keyed.init.headers["x-key"]).toBe("secret-value-1");
  });

  it("refuses a path that leaves the proven folder", () => {
    expect(() => buildUpstreamRequest({ origin: "https://a.com", path_prefix: "/v1" }, { method: "GET", path: "/{id}" }, { id: ".." })).toThrow(/invalid path parameter/);
  });

  it("asks a text promise for its own type", () => {
    expect(acceptFor("text/plain")).toBe("text/plain, text/*;q=0.9");
    expect(acceptFor(null)).toBe("application/json");
  });
});
