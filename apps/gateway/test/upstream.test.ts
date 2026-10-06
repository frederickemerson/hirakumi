import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileRule } from "@hirakumi/core";
import { compileInputValidator, type LoadedOp } from "../src/registry";
import { buildUpstreamRequest, normalizeMip003Input, runOperation } from "../src/upstream";
import { PRICE_INPUT_SCHEMA, PRICE_RULE, startStubUpstream, type StubUpstream } from "./helpers";

let stub: StubUpstream;
beforeAll(async () => { stub = await startStubUpstream(); });
afterAll(async () => { await stub.close(); });

const op = (): LoadedOp => ({
  row: { id: "op_x", api_id: "api_x", op_id: "getPrice", method: "GET", path: "/price", input_schema: PRICE_INPUT_SCHEMA, description: null, enabled: true },
  ruleRow: null,
  rule: compileRule(PRICE_RULE),
  validateInput: compileInputValidator(PRICE_INPUT_SCHEMA),
});

describe("buildUpstreamRequest", () => {
  it("fills path params, sends the rest as query for GET", () => {
    const r = buildUpstreamRequest({ origin: "https://a.example/", path_prefix: "/v1/" }, { method: "get", path: "/price/{symbol}" }, { symbol: "ADA", fiat: "usd" });
    expect(r.url).toBe("https://a.example/v1/price/ADA?fiat=usd");
    expect(r.init).toEqual({ method: "GET", headers: { accept: "application/json", "user-agent": "hirakumi-gateway/0.1" } });
  });
  it("sends a JSON body for POST", () => {
    const r = buildUpstreamRequest({ origin: "https://a.example", path_prefix: "/" }, { method: "POST", path: "/quote" }, { symbol: "ADA" });
    expect(r.url).toBe("https://a.example/quote");
    expect(r.init.body).toBe('{"symbol":"ADA"}');
    expect(r.init.headers["content-type"]).toBe("application/json");
  });
  it("fails on a missing path parameter", () => {
    expect(() => buildUpstreamRequest({ origin: "https://a.example", path_prefix: "/" }, { method: "GET", path: "/p/{id}" }, {})).toThrow(/id/);
  });
});

describe("normalizeMip003Input", () => {
  it("accepts an object or a [{key,value}] list", () => {
    expect(normalizeMip003Input({ symbol: "ADA" })).toEqual({ symbol: "ADA" });
    expect(normalizeMip003Input([{ key: "symbol", value: "ADA" }])).toEqual({ symbol: "ADA" });
    expect(normalizeMip003Input([{ nokey: 1 }])).toBeNull();
    expect(normalizeMip003Input("ADA")).toBeNull();
  });
});

describe("runOperation", () => {
  const api = () => ({ origin: stub.origin, path_prefix: "/" });
  it("pass", async () => {
    stub.setMode("ok");
    const o = await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500 });
    expect(o).toMatchObject({ execution: "upstream_ok", verdict: "pass", reasons: [] });
    expect(JSON.parse(o.result!.body).symbol).toBe("ADA");
  });
  it("rule fail on {}", async () => {
    stub.setMode("empty");
    const o = await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500 });
    expect(o.execution).toBe("upstream_ok");
    expect(o.verdict).toBe("fail");
    expect(o.reasons).toContain("/price is missing");
  });
  it("upstream 5xx is upstream_error", async () => {
    stub.setMode("error500");
    expect(await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500 })).toMatchObject({ execution: "upstream_error", verdict: "fail" });
  });
  it("timeout", async () => {
    stub.setMode("slow");
    expect(await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 200 })).toMatchObject({ execution: "timeout", verdict: "fail", result: null });
  });
  it("blocked origin", async () => {
    expect(await runOperation({ origin: "https://169.254.169.254", path_prefix: "/" }, op(), { symbol: "ADA" }, { timeoutMs: 200 }))
      .toMatchObject({ execution: "blocked", verdict: "n/a" });
  });
  it("probe header is sent only for probes", async () => {
    stub.setMode("ok");
    await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500, probe: true });
    expect(stub.lastHeaders()?.["x-hirakumi-probe"]).toBe("1");
    await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500 });
    expect(stub.lastHeaders()?.["x-hirakumi-probe"]).toBeUndefined();
  });
});
