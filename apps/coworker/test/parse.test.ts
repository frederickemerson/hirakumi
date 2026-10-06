import { describe, expect, it } from "vitest";
import { PermanentError } from "../src/errors.js";
import { OpenApiError, parseOpenApi, toOpId } from "../src/openapi/parse.js";
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
      { method: "GET", path: "/me", reason: "needs authentication (not supported yet)" },
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
