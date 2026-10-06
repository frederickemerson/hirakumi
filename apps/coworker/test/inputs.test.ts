import { describe, expect, it } from "vitest";
import { PermanentError } from "../src/errors.js";
import type { InputSchema } from "../src/openapi/parse.js";
import { buildBadInput, buildGoodInputs, INVALID_STRING } from "../src/qa/inputs.js";

const schema = (properties: InputSchema["properties"], required: string[]): InputSchema => ({ type: "object", properties, required, additionalProperties: false });

describe("buildGoodInputs", () => {
  it("builds a base input plus one variant per extra example or enum value", () => {
    const s = schema({ symbol: { type: "string", enum: ["ADA", "BTC"] }, days: { type: "integer", default: 7, examples: [30] } }, ["symbol"]);
    expect(buildGoodInputs(s, [], "hist")).toEqual([
      { symbol: "ADA", days: 30 },
      { symbol: "BTC", days: 30 },
      { symbol: "ADA", days: 7 },
    ]);
  });

  it("puts seller samples first and dedupes", () => {
    const s = schema({ symbol: { type: "string", examples: ["ADA"] } }, ["symbol"]);
    expect(buildGoodInputs(s, [{ symbol: "ETH" }, { symbol: "ADA" }], "p")).toEqual([{ symbol: "ETH" }, { symbol: "ADA" }]);
  });

  it("asks for an example when a required value is unknown and no samples exist", () => {
    const s = schema({ symbol: { type: "string" } }, ["symbol"]);
    expect(() => buildGoodInputs(s, [], "getPrice")).toThrow(PermanentError);
    expect(() => buildGoodInputs(s, [], "getPrice")).toThrow(/example value for "symbol"/);
    expect(buildGoodInputs(s, [{ symbol: "ADA" }], "getPrice")).toEqual([{ symbol: "ADA" }]);
  });
});

describe("buildBadInput", () => {
  it("replaces free-form strings with a value no real API knows", () => {
    const s = schema({ symbol: { type: "string" }, days: { type: "integer" } }, ["symbol"]);
    expect(buildBadInput(s, { symbol: "ADA", days: 7 })).toEqual({ symbol: INVALID_STRING, days: 7 });
  });

  it("returns null when no parameter can be made wrong without breaking the schema", () => {
    const s = schema({ symbol: { type: "string", enum: ["ADA"] }, n: { type: "integer" } }, ["symbol"]);
    expect(buildBadInput(s, { symbol: "ADA", n: 1 })).toBeNull();
  });
});
