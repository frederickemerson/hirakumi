import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerLeaksSecret, compileRule, inferTextRule, KEY_FORBIDDEN_TEXT, KEY_REFUSED_TEXT, KEY_UNSCANNABLE_TEXT, renderPreset, upstreamSecretParts,
  validateUpstreamBag, withRequiredPhrase, type UpstreamAuth, type UpstreamCredential,
} from "@hirakumi/core";
import { compileInputValidator, type LoadedOp } from "../src/registry";
import { buildUpstreamRequest, leaksSecret, normalizeMip003Input, redactSecret, resolveAuth, runOperation, secretForms } from "../src/upstream";
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
  it("asks for exactly application/json for a JSON promise or none yet, and a text promise's own type without */*", () => {
    const accept = (ct?: string | null) => buildUpstreamRequest({ origin: "https://a.example", path_prefix: "/" }, { method: "GET", path: "/p" }, {}, ct).init.headers.accept;
    // Rails answers HTML to any Accept with ", */*" in it, so JSON listings (and QA of a new one) ask for JSON only.
    for (const ct of [undefined, null, "application/json", "application/vnd.api+json", "text/json"]) expect(accept(ct), String(ct)).toBe("application/json");
    expect(accept("text/csv")).toBe("text/csv, text/*;q=0.9");
    expect(accept("application/xml")).toBe("application/xml, text/*;q=0.9");
    for (const ct of ["text/csv", "text/plain", "application/xml"]) expect(accept(ct)).not.toContain("*/*");
  });
  it("sends the operation's promised type upstream", async () => {
    stub.setMode("ok");
    await runOperation({ origin: stub.origin, path_prefix: "/" }, op(), { symbol: "ADA" }, { timeoutMs: 500 });
    expect(stub.lastHeaders()?.accept).toBe("application/json");
    await runOperation({ origin: stub.origin, path_prefix: "/" }, { ...op(), rule: null }, { symbol: "ADA" }, { timeoutMs: 500 });
    expect(stub.lastHeaders()?.accept).toBe("application/json");
    const csv = compileRule(inferTextRule("text/csv", ["a\n1\n", "a\n2\n"]));
    await runOperation({ origin: stub.origin, path_prefix: "/" }, { ...op(), rule: csv }, { symbol: "ADA" }, { timeoutMs: 500 });
    expect(stub.lastHeaders()?.accept).toBe("text/csv, text/*;q=0.9");
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
  it.each([["../../other/x"], ["..%2F..%2Fother"], ["..\\..\\other"], ["%5C..%5Cother"], ["a/b"]])(
    "refuses a path parameter %j with a slash or backslash, which a server that decodes %%2F/%%5C would route elsewhere",
    (id) => {
      const api = { origin: "https://h.example", path_prefix: "/tenant/a", credential: headerKey, credentialError: null };
      expect(() => buildUpstreamRequest(api, { method: "GET", path: "/coins/{id}" }, { id })).toThrow(/invalid path parameter id/);
    },
  );
  it("still allows ordinary path parameter values, dots and encoded characters included", () => {
    const r = buildUpstreamRequest({ origin: "https://h.example", path_prefix: "/tenant/a" }, { method: "GET", path: "/coins/{id}" }, { id: "usd-coin v2.1&x" });
    expect(r.url).toBe("https://h.example/tenant/a/coins/usd-coin%20v2.1%26x");
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

const KEY = "sk_live/Ab+cd=ef 0123456789";
const headerKey: UpstreamCredential = { in: "header", name: "X-API-Key", value: KEY };
const queryKey: UpstreamCredential = { in: "query", name: "api_key", value: KEY };

describe("the seller's key", () => {
  it("goes in the named header, lowercased, after the gateway's own headers", () => {
    const r = buildUpstreamRequest(
      { origin: "https://a.example", path_prefix: "/", credential: headerKey, credentialError: null }, { method: "GET", path: "/price" }, { symbol: "ADA" },
    );
    expect(r.url).toBe("https://a.example/price?symbol=ADA");
    expect(r.init.headers["x-api-key"]).toBe(KEY);
  });
  it("goes in the query, and a buyer input with the same name cannot replace it", () => {
    const r = buildUpstreamRequest(
      { origin: "https://a.example", path_prefix: "/", credential: queryKey, credentialError: null }, { method: "GET", path: "/price" },
      { symbol: "ADA", api_key: ["mine", "also-mine"] },
    );
    const url = new URL(r.url);
    expect(url.searchParams.getAll("api_key")).toEqual([KEY]);
    expect(url.searchParams.get("symbol")).toBe("ADA");
  });
  it("reaches the API in a real request: header and query", async () => {
    stub.setMode("ok");
    const h = await runOperation({ origin: stub.origin, path_prefix: "/", credential: headerKey, credentialError: null }, op(), { symbol: "ADA" }, { timeoutMs: 500 });
    expect(h).toMatchObject({ execution: "upstream_ok", verdict: "pass" });
    expect(stub.lastHeaders()?.["x-api-key"]).toBe(KEY);
    const q = await runOperation(
      { origin: stub.origin, path_prefix: "/", credential: queryKey, credentialError: null }, op(), { symbol: "ADA", api_key: "buyer-guess" }, { timeoutMs: 500 },
    );
    expect(q).toMatchObject({ execution: "upstream_ok", verdict: "pass" });
    expect(new URL(stub.lastUrl()!, "http://x").searchParams.getAll("api_key")).toEqual([KEY]);
    expect(stub.lastHeaders()?.["x-api-key"]).toBeUndefined();
  });
  it("a key that can't be opened blocks the call before anything is sent", async () => {
    stub.setMode("ok");
    const before = stub.hits();
    const o = await runOperation(
      { origin: stub.origin, path_prefix: "/", credential: null, credentialError: "this API's key could not be read. The seller should enter it again" },
      op(), { symbol: "ADA" }, { timeoutMs: 500 },
    );
    expect(o).toMatchObject({ execution: "blocked", verdict: "n/a", result: null });
    expect(o.reasons[0]).toMatch(/^blocked: this API's key could not be read/);
    expect(stub.hits()).toBe(before);
  });
  it.each([["header (raw)", headerKey], ["query (percent-encoded)", queryKey]])(
    "an answer that repeats the key in the %s is withheld and counts as failed",
    async (_label, credential) => {
      stub.setMode("echo");
      const o = await runOperation({ origin: stub.origin, path_prefix: "/", credential, credentialError: null }, op(), { symbol: "ADA" }, { timeoutMs: 500 });
      expect(o).toMatchObject({ execution: "upstream_error", verdict: "fail", result: null, reasons: ["the answer contained the API's key, so it was withheld"] });
      // Without a key, the same echo answer passes: the rule alone does not catch it.
      const plain = await runOperation({ origin: stub.origin, path_prefix: "/" }, op(), { symbol: "ADA" }, { timeoutMs: 500 });
      expect(plain).toMatchObject({ execution: "upstream_ok", verdict: "pass" });
    },
  );
  it("an operation without a rule withholds the answer too (verdict n/a)", async () => {
    stub.setMode("echo");
    const o = await runOperation({ origin: stub.origin, path_prefix: "/", credential: headerKey, credentialError: null }, { ...op(), rule: null }, { symbol: "ADA" }, { timeoutMs: 500 });
    expect(o).toMatchObject({ execution: "upstream_error", verdict: "n/a", result: null });
  });
  it("finds the key raw, percent-encoded (either hex case), form-encoded and JSON-escaped", () => {
    const forms = secretForms(KEY);
    for (const f of [KEY, encodeURIComponent(KEY), "sk_live%2FAb%2Bcd%3Def+0123456789", "sk_live%2fAb%2bcd%3def+0123456789", "sk_live\\/Ab+cd=ef 0123456789"]) {
      expect(forms, f).toContain(f.toLowerCase());
      expect(leaksSecret(`{"error":"bad key ${f}"}`, queryKey), f).toBe(true);
    }
    for (const f of forms) expect(leaksSecret(`{"error":"bad key ${f}"}`, queryKey)).toBe(true);
    expect(leaksSecret("sk_live", queryKey)).toBe(false);
    expect(leaksSecret(null, queryKey)).toBe(false);
  });
  it("uses the core check, so it agrees with answerLeaksSecret and redacts what it finds", () => {
    const bearer: UpstreamCredential = { in: "header", name: "Authorization", value: "Bearer Ab<1&2>" };
    const echoes = [
      "AB<1&2>", "ab&lt;1&amp;2&gt;", "Ab\\u003c1\\u00262\\u003e", Buffer.from("Bearer Ab<1&2>").toString("base64"),
      Buffer.from("Ab<1&2>").toString("base64url"), "ab%3c1%262%3e",
    ];
    for (const e of echoes) {
      const text = `{"error":"bad token ${e}"}`;
      expect(leaksSecret(text, bearer), e).toBe(true);
      expect(answerLeaksSecret(text, bearer), e).toBe(true);
      expect(redactSecret(text, bearer), e).toBe('{"error":"bad token [key]"}');
      expect(leaksSecret(redactSecret(text, bearer), bearer), e).toBe(false);
    }
    expect(leaksSecret('{"error":"bad token"}', bearer)).toBe(false);
  });
  it("finds and redacts a bearer token echoed without its 'Bearer ' prefix", () => {
    const bearer: UpstreamCredential = { in: "header", name: "Authorization", value: "Bearer sk_abc123def456" };
    expect(leaksSecret('{"error":"token sk_abc123def456 is not valid"}', bearer)).toBe(true);
    expect(leaksSecret('{"error":"token sk_abc123def456"}', { ...bearer, value: "Token sk_abc123def456" })).toBe(true);
    expect(leaksSecret('{"error":"Bearer token missing"}', bearer)).toBe(false);
    expect(redactSecret("upstream said: sk_abc123def456 is not valid", bearer)).toBe("upstream said: [key] is not valid");
    expect(redactSecret("sent Bearer sk_abc123def456", bearer)).toBe("sent [key]");
  });
  it("redacts the key from a reason that quotes the URL", () => {
    const url = buildUpstreamRequest({ origin: "https://a.example", path_prefix: "/", credential: queryKey, credentialError: null }, { method: "GET", path: "/p" }, {}).url;
    expect(url).toContain("api_key=");
    expect(redactSecret(`request to ${url} failed; key ${KEY}`, queryKey)).toBe("request to https://a.example/p?api_key=[key] failed; key [key]");
    expect(redactSecret("got sk_live%2fAb%2bcd%3def+0123456789 back", queryKey)).toBe("got [key] back");
    expect(redactSecret("nothing here", null)).toBe("nothing here");
  });
});

describe("text answers", () => {
  const csvOp = (): LoadedOp => {
    const rule = withRequiredPhrase(inferTextRule("text/csv", ["symbol,price\nADA,0.42\n", "symbol,price\nBTC,60000\n"]), "symbol,price");
    return {
      row: { id: "op_csv", api_id: "api_x", op_id: "getCsv", method: "GET", path: "/prices.csv", input_schema: { type: "object" }, description: null, enabled: true },
      ruleRow: null, rule: compileRule(rule), validateInput: compileInputValidator({ type: "object" }),
    };
  };
  it("a CSV answer passes a text rule and keeps its body as is", async () => {
    stub.setFile("/prices.csv", "symbol,price\r\nADA,0.42\r\n", { contentType: "text/csv; charset=utf-8" });
    const o = await runOperation({ origin: stub.origin, path_prefix: "/" }, csvOp(), {}, { timeoutMs: 500 });
    expect(o).toMatchObject({ execution: "upstream_ok", verdict: "pass", reasons: [] });
    expect(o.result).toMatchObject({ contentType: "text/csv; charset=utf-8", body: "symbol,price\r\nADA,0.42\r\n" });
  });
  it("fails a CSV answer without the confirmed phrase, or with another content type", async () => {
    stub.setFile("/prices.csv", "oops\n", { contentType: "text/csv" });
    expect(await runOperation({ origin: stub.origin, path_prefix: "/" }, csvOp(), {}, { timeoutMs: 500 })).toMatchObject({ execution: "upstream_ok", verdict: "fail" });
    stub.setFile("/prices.csv", "symbol,price\nADA,1\n", { contentType: "text/plain" });
    const o = await runOperation({ origin: stub.origin, path_prefix: "/" }, csvOp(), {}, { timeoutMs: 500 });
    expect(o.verdict).toBe("fail");
    expect(o.reasons[0]).toMatch(/content type is text\/plain, expected text\/csv/);
  });
});

const b64 = (t: string) => Buffer.from(t).toString("base64");
/** The price operation pointed at another stub path, with the price rule or none. */
const opAt = (path: string, rule: LoadedOp["rule"] | null = compileRule(PRICE_RULE)): LoadedOp => ({ ...op(), row: { ...op().row, path }, rule });
/** A bag's opened auth, from a preset as the web app renders it. */
const bagAuth = (preset: string, fields: unknown): UpstreamAuth => {
  const r = renderPreset(preset, fields);
  if (r.kind !== "hks3") throw new Error("expected a bag");
  return validateUpstreamBag(r.parts, r);
};
const SUPA = "sb_secret_0123456789abcdefWXYZ";
const twoHeaders = () => bagAuth("twoHeaders", { rows: [
  { in: "header", name: "apikey", value: SUPA }, { in: "header", name: "Authorization", value: SUPA, scheme: "Bearer" },
] });
const PASSWORD = "pw-0123456789xyz";
/** HTTP Basic with a password, sealed with an empty leak list: the gateway derives the password and pair itself. */
const basicNoLeak = (): UpstreamAuth =>
  validateUpstreamBag([{ in: "header", name: "Authorization" }], { values: [`Basic ${b64(`alice-public:${PASSWORD}`)}`], fixed: [], leak: [] });

describe("resolveAuth", () => {
  it("a credential gives today's parts and leak set; a bag gives its own; no key gives null", () => {
    expect(resolveAuth({ credential: headerKey, credentialError: null })).toEqual({ parts: [headerKey], leakParts: upstreamSecretParts(KEY) });
    const auth = twoHeaders();
    expect(resolveAuth({ credential: null, credentialError: null, auth })).toBe(auth);
    expect(resolveAuth({})).toBeNull();
    expect(resolveAuth({ credential: null, credentialError: "x" })).toBeNull();
  });
});

describe("keys of several parts (hks3) and keyed answers", () => {
  it("a single key's request is today's plus accept-encoding: identity; a keyless one is unchanged", () => {
    const r = buildUpstreamRequest({ origin: "https://a.example", path_prefix: "/", credential: headerKey, credentialError: null }, { method: "GET", path: "/p" }, {});
    expect(r.init).toEqual({ method: "GET", headers: { accept: "application/json", "user-agent": "hirakumi-gateway/0.1", "accept-encoding": "identity", "x-api-key": KEY } });
    expect(buildUpstreamRequest({ origin: "https://a.example", path_prefix: "/" }, { method: "GET", path: "/p" }, {}).init.headers["accept-encoding"]).toBeUndefined();
  });
  it("sends every part after the buyer's fields, so a buyer field of the same name can't replace one", async () => {
    const auth = bagAuth("headerPlusQuery", { rows: [
      { in: "header", name: "X-App-Id", value: "app-public-id", fixed: true }, { in: "query", name: "key", value: SUPA },
    ] });
    const api = { origin: stub.origin, path_prefix: "/", credential: null, credentialError: null, auth };
    const r = buildUpstreamRequest(api, { method: "GET", path: "/p" }, { symbol: "ADA", key: "buyer" });
    expect(new URL(r.url).searchParams.getAll("key")).toEqual([SUPA]);
    expect(r.init.headers["x-app-id"]).toBe("app-public-id");
    stub.setMode("ok");
    const o = await runOperation({ ...api, auth: twoHeaders() }, op(), { symbol: "ADA" }, { timeoutMs: 500 });
    expect(o).toMatchObject({ execution: "upstream_ok", verdict: "pass" });
    expect(stub.lastHeaders()).toMatchObject({ apikey: SUPA, authorization: `Bearer ${SUPA}`, "accept-encoding": "identity" });
  });
  it.each([
    ["the key raw", twoHeaders, `{"echo":"${SUPA}"}`],
    ["the key base64", twoHeaders, `{"echo":"${b64(SUPA)}"}`],
    ["the sent Bearer value base64", twoHeaders, `{"echo":"${b64(`Bearer ${SUPA}`)}"}`],
    ["the Basic header", basicNoLeak, `{"echo":"Basic ${b64(`alice-public:${PASSWORD}`)}"}`],
    ["the derived password (leak list empty)", basicNoLeak, `{"echo":"${PASSWORD}"}`],
    ["the derived pair, base64", basicNoLeak, `{"echo":"${b64(`alice-public:${PASSWORD}`)}"}`],
  ] as const)("an answer that repeats %s is withheld and nothing quotes it", async (_label, auth, body) => {
    stub.setFile("/leak", body);
    const o = await runOperation({ origin: stub.origin, path_prefix: "/", credential: null, credentialError: null, auth: auth() }, opAt("/leak", null), {}, { timeoutMs: 500 });
    expect(o).toMatchObject({ execution: "upstream_error", verdict: "n/a", result: null, reasons: ["the answer contained the API's key, so it was withheld"] });
    for (const secret of [SUPA, PASSWORD, b64(SUPA)]) expect(JSON.stringify(o)).not.toContain(secret);
  });
  it("an echoed Basic user name is not withheld (it is often public)", async () => {
    stub.setFile("/user", `{"user":"alice-public"}`);
    const o = await runOperation({ origin: stub.origin, path_prefix: "/", auth: basicNoLeak() }, opAt("/user", null), {}, { timeoutMs: 500 });
    expect(o).toMatchObject({ execution: "upstream_ok", verdict: "n/a" });
  });
  it("a keyed 401 or 403 leads with the key reason and tags auth; a keyless one does not", async () => {
    stub.setFile("/k401", '{"error":"unauthorized"}', { status: 401 });
    stub.setFile("/k403", '{"error":"forbidden"}', { status: 403 });
    const keyed = { origin: stub.origin, path_prefix: "/", credential: headerKey, credentialError: null };
    const refused = await runOperation(keyed, opAt("/k401"), {}, { timeoutMs: 500 });
    expect(refused).toMatchObject({ execution: "upstream_ok", verdict: "fail", auth: "refused" });
    expect(refused.reasons[0]).toBe(KEY_REFUSED_TEXT);
    expect(refused.reasons.length).toBeGreaterThan(1);
    const forbidden = await runOperation({ ...keyed, credential: null, auth: twoHeaders() }, opAt("/k403", null), {}, { timeoutMs: 500 });
    expect(forbidden).toMatchObject({ verdict: "n/a", auth: "forbidden", reasons: [KEY_FORBIDDEN_TEXT] });
    expect(forbidden.result?.status).toBe(403);
    const keyless = await runOperation({ origin: stub.origin, path_prefix: "/" }, opAt("/k401"), {}, { timeoutMs: 500 });
    expect(keyless.auth).toBeUndefined();
    expect(keyless.reasons).not.toContain(KEY_REFUSED_TEXT);
  });
  it("a compressed answer is withheld when keyed and passed through when keyless", async () => {
    stub.setFile("/gz", gzipSync(`{"echo":"${SUPA}"}`), { headers: { "content-encoding": "gzip" } });
    const keyed = await runOperation({ origin: stub.origin, path_prefix: "/", auth: twoHeaders() }, opAt("/gz", null), {}, { timeoutMs: 500 });
    expect(keyed).toMatchObject({ execution: "upstream_error", verdict: "n/a", result: null, reasons: [KEY_UNSCANNABLE_TEXT] });
    expect(stub.lastFileHeaders()?.["accept-encoding"]).toBe("identity");
    const keyless = await runOperation({ origin: stub.origin, path_prefix: "/" }, opAt("/gz", null), {}, { timeoutMs: 500 });
    expect(keyless).toMatchObject({ execution: "upstream_ok", verdict: "n/a" });
    expect(keyless.result?.contentEncoding).toBe("gzip");
  });
  it("an upstream 429 keeps its status and Retry-After in seconds", async () => {
    stub.setFile("/busy", '{"error":"slow down"}', { status: 429, headers: { "retry-after": "7" } });
    const o = await runOperation({ origin: stub.origin, path_prefix: "/" }, opAt("/busy"), {}, { timeoutMs: 500 });
    expect(o).toMatchObject({ execution: "upstream_ok", verdict: "fail", retryAfter: 7 });
    expect(o.result?.status).toBe(429);
    expect(o.auth).toBeUndefined();
  });
});
