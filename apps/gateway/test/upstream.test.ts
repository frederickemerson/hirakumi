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
  it("POST follows the shared input convention: `body` is the JSON body, other fields are query (contract P3 #3)", () => {
    const r = buildUpstreamRequest(
      { origin: "https://a.example", path_prefix: "/" }, { method: "POST", path: "/quote/{venue}" },
      { venue: "dex", currency: "usd", body: { symbol: "ADA", qty: 2 } },
    );
    expect(r.url).toBe("https://a.example/quote/dex?currency=usd");
    expect(r.init.body).toBe('{"symbol":"ADA","qty":2}');
    expect(r.init.headers["content-type"]).toBe("application/json");
  });
  it("POST without a `body` field sends no body", () => {
    const r = buildUpstreamRequest({ origin: "https://a.example", path_prefix: "/" }, { method: "POST", path: "/ping" }, { verbose: true });
    expect(r.url).toBe("https://a.example/ping?verbose=true");
    expect(r.init.body).toBeUndefined();
    expect(r.init.headers["content-type"]).toBeUndefined();
  });
  it.each([[".."], ["."], [""], ["%2e%2e"]])("refuses the dot-segment or empty path parameter %j (stays inside the verified prefix)", (id) => {
    expect(() => buildUpstreamRequest({ origin: "https://a.example", path_prefix: "/v1" }, { method: "GET", path: "/items/{id}" }, { id })).toThrow(/path parameter/);
  });
  it.each([["/../~victim/data"], ["/%2e%2e/~victim/data"], ["/%2E%2E/~victim/data"]])(
    "blocks an operation path %j that leaves the proven folder (audit C1)",
    (path) => {
      expect(() => buildUpstreamRequest({ origin: "https://host", path_prefix: "/~attacker" }, { method: "GET", path }, {}))
        .toThrow(/outside the API's folder/);
    },
  );
  it("blocks a stored path that would change the host (audit C1)", () => {
    expect(() => buildUpstreamRequest({ origin: "https://host", path_prefix: "" }, { method: "GET", path: "@evil.example/x" }, {}))
      .toThrow(/outside the API's folder/);
  });
  it("still allows the base path itself and paths under it", () => {
    expect(buildUpstreamRequest({ origin: "https://host", path_prefix: "/~attacker" }, { method: "GET", path: "" }, {}).url).toBe("https://host/~attacker");
    expect(buildUpstreamRequest({ origin: "https://host", path_prefix: "/~attacker" }, { method: "GET", path: "/data" }, {}).url).toBe("https://host/~attacker/data");
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
  it("a path that leaves the proven folder is blocked with a reason and never reaches the network (audit C1)", async () => {
    stub.setMode("ok");
    const before = stub.hits();
    const evil = op();
    evil.row = { ...evil.row, path: "/%2e%2e/price" };
    const o = await runOperation({ origin: stub.origin, path_prefix: "/~attacker" }, evil, { symbol: "ADA" }, { timeoutMs: 500 });
    expect(o).toMatchObject({ execution: "blocked", verdict: "n/a", result: null });
    expect(o.reasons[0]).toMatch(/outside the API's folder/);
    expect(stub.hits()).toBe(before);
  });
  it("probe header is sent only for probes", async () => {
    stub.setMode("ok");
    await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500, probe: true });
    expect(stub.lastHeaders()?.["x-hirakumi-probe"]).toBe("1");
    await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500 });
    expect(stub.lastHeaders()?.["x-hirakumi-probe"]).toBeUndefined();
  });
});
