import { describe, expect, it, vi } from "vitest";
import { PermanentError } from "../src/errors.js";
import type { GatewayClient, PreviewResult } from "../src/gateway.js";
import type { InputSchema } from "../src/openapi/parse.js";
import { INVALID_STRING } from "../src/qa/inputs.js";
import { MIN_CALLS, NeedsKeyError, qaOperation } from "../src/qa/runQa.js";

const SCHEMA: InputSchema = { type: "object", properties: { symbol: { type: "string", examples: ["ADA", "BTC"] } }, required: ["symbol"], additionalProperties: false };
const json = (status: number, body: unknown): PreviewResult => ({ status, contentType: "application/json", body: JSON.stringify(body), latencyMs: 5 });

function fakeGateway(answer: (input: Record<string, unknown>) => PreviewResult) {
  const preview = vi.fn(async (_api: string, _op: string, input: Record<string, unknown>) => answer(input));
  return { gateway: { preview } as GatewayClient, preview };
}

describe("qaOperation", () => {
  it("runs at least 5 parallel good calls plus one bad-input call and returns a rule that rejects the bad answer", async () => {
    const { gateway, preview } = fakeGateway((i) => (i.symbol === INVALID_STRING ? json(404, { error: "unknown symbol" }) : json(200, { symbol: i.symbol, price: 0.31 })));
    const r = await qaOperation(gateway, "api_1", { op_id: "getPrice", input_schema: SCHEMA }, []);
    expect(preview).toHaveBeenCalledTimes(MIN_CALLS + 1);
    expect(preview.mock.calls.at(-1)?.[2]).toEqual({ symbol: INVALID_STRING });
    expect(r.calls).toBe(6);
    expect(r.badInput).toBe("rejected");
    expect(r.testInputs).toEqual([{ symbol: "ADA" }, { symbol: "BTC" }]);
    expect((r.rule.schema as { required: string[] }).required).toEqual(expect.arrayContaining(["symbol", "price"]));
  });

  it("refuses to build a promise that can't tell a wrong request from a right one", async () => {
    const { gateway } = fakeGateway(() => json(200, { symbol: "ADA", price: 0.31 }));
    await expect(qaOperation(gateway, "api_1", { op_id: "getPrice", input_schema: SCHEMA }, [])).rejects.toBeInstanceOf(PermanentError);
  });

  it("treats a failing good call as retryable, not permanent", async () => {
    const { gateway } = fakeGateway(() => json(500, { error: "boom" }));
    const p = qaOperation(gateway, "api_1", { op_id: "getPrice", input_schema: SCHEMA }, []);
    await expect(p).rejects.toThrow(/did not return a success Hirakumi can check \(HTTP 500\)/);
    await expect(p).rejects.not.toBeInstanceOf(PermanentError);
  });
});

describe("qaOperation for answers that aren't plain JSON", () => {
  const text = (status: number, body: string, contentType = "text/csv"): PreviewResult => ({ status, contentType, body, latencyMs: 5 });

  it("builds a text promise for CSV, with the header line required", async () => {
    const { gateway } = fakeGateway((i) => (i.symbol === INVALID_STRING ? text(404, "unknown symbol", "text/plain") : text(200, `symbol,price\n${String(i.symbol)},1`)));
    const r = await qaOperation(gateway, "api_1", { op_id: "getPrice", input_schema: SCHEMA }, []);
    expect(r.rule).toMatchObject({ contentType: "text/csv", schema: { type: "string", minLength: 1, pattern: "^symbol,price\\r?\\n" } });
  });

  it("refuses binary answers for good, with a reason the seller can act on", async () => {
    const { gateway } = fakeGateway(() => text(200, "%PDF-1.7", "application/pdf"));
    const p = qaOperation(gateway, "api_1", { op_id: "getPrice", input_schema: SCHEMA }, []);
    await expect(p).rejects.toBeInstanceOf(PermanentError);
    await expect(p).rejects.toThrow(/application\/pdf, which Hirakumi can't check yet/);
  });

  it("points at the key setting when the API refuses the test calls", async () => {
    const { gateway } = fakeGateway(() => json(401, { error: "missing api key" }));
    const p = qaOperation(gateway, "api_1", { op_id: "getPrice", input_schema: SCHEMA }, []);
    await expect(p).rejects.toBeInstanceOf(PermanentError);
    await expect(p).rejects.toThrow(/add it on the review page. The test calls then run again/);
    await expect(p).rejects.toBeInstanceOf(NeedsKeyError);
  });
});
