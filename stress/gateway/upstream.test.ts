// A hostile or broken seller behind the gateway: hangs, endless streams, huge or mislabelled bodies, redirects
// to internal addresses, answers that echo the sealed key, and origins that point inside the network (SSRF).
// Safe behaviour: the buyer gets a 4xx/5xx with no credit used, the gateway stays fast and small, the key never
// reaches the buyer, and no request leaves for a private address.
import net from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateUpstreamAuthKeys, sealUpstreamSecret } from "@hirakumi/core";
import { ApiRegistry } from "../../apps/gateway/src/registry";
import { createApp } from "../../apps/gateway/src/app";
import { anotherBase, insertActiveToken, makeHarness, passingBody, seedLiveApi, serve, startHostileSeller, tally, type Harness, type SellerReply } from "./kit";

let h: Harness;
let seller: Awaited<ReturnType<typeof startHostileSeller>>;
let srv: Awaited<ReturnType<typeof serve>>;
let s: Awaited<ReturnType<typeof seedLiveApi>>;
beforeAll(async () => {
  h = await makeHarness({ config: { upstreamTimeoutMs: 1_500 } });
  seller = await startHostileSeller();
  s = await seedLiveApi(h.sql, seller.origin);
  srv = await serve(h.app);
});
afterAll(async () => { await srv?.close(); await seller?.close(); await h?.close(); });
afterEach(() => seller.setReply(() => ({})));

async function callOnce(reply: SellerReply | ((n: number) => SellerReply)) {
  seller.setReply((_req, n) => (typeof reply === "function" ? reply(n) : reply));
  const { token, id } = await insertActiveToken(h.sql, s, 3);
  const t0 = performance.now();
  const r = await srv.req(`/a/${s.apiId}/x/getPrice?symbol=ADA`, { headers: { authorization: `Bearer ${token}` } });
  const ms = Math.round(performance.now() - t0);
  const [row] = await h.sql<{ remaining: number }[]>`select remaining from credit_tokens where id = ${id}`;
  return { status: r.status, body: r.text, ms, used: 3 - row!.remaining };
}

describe("hostile seller answers", () => {
  it("each failure mode answers fast with no credit used", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024, 0x61);
    const cases: [string, SellerReply, number[]][] = [
      ["hang", "hang", [504]],
      ["endless stream", "stream", [502, 504]],
      ["10 MB body", { body: big }, [502]],
      ["socket destroyed", "destroy", [502]],
      ["html labelled", { headers: { "content-type": "text/html" }, body: passingBody() }, [422]],
      ["json labelled text/plain", { headers: { "content-type": "text/plain" }, body: passingBody() }, [422]],
      ["gzip without asking", { headers: { "content-encoding": "gzip" }, body: gzipSync(passingBody()) }, [422]],
      ["302 to metadata", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" }, body: "" }, [502]],
      ["307 to localhost admin", { status: 307, headers: { location: "http://127.0.0.1:5432/" }, body: "" }, [502]],
      ["304", { status: 304, body: "" }, [502]],
      ["204", { status: 204, body: "" }, [422]],
      ["500 with valid body", { status: 500, body: passingBody() }, [502]],
      ["NaN price", { body: '{"symbol":"ADA","price":NaN,"updatedAt":"2020-01-01T00:00:00Z"}' }, [422]],
      ["duplicate keys", { body: `{"symbol":"ADA","price":"x","price":1,"updatedAt":"${new Date().toISOString()}"}` }, [200, 422]],
      ["future timestamp", { body: JSON.stringify({ symbol: "ADA", price: 1, updatedAt: "2999-01-01T00:00:00Z" }) }, [422]],
      ["deep nesting", { body: `{"symbol":"ADA","price":1,"updatedAt":"${new Date().toISOString()}","x":${"[".repeat(50_000)}${"]".repeat(50_000)}}` }, [200, 422, 502]],
      ["1 MB minus 1 of whitespace", { body: passingBody() + " ".repeat(1_048_575 - passingBody().length) }, [200]],
    ];
    const out: string[] = [];
    const bad: string[] = [];
    for (const [name, reply, ok] of cases) {
      const r = await callOnce(reply);
      out.push(`${name}=${r.status}/${r.ms}ms/used${r.used}`);
      if (!ok.includes(r.status)) bad.push(`${name}: status ${r.status} not in ${ok}`);
      if ((r.status === 200) !== (r.used === 1) || r.used > 1) bad.push(`${name}: status ${r.status} but used ${r.used}`);
      if (r.ms > 4_000) bad.push(`${name}: took ${r.ms} ms`);
    }
    expect(bad, out.join(" ")).toEqual([]);
  });

  it("a future timestamp is NOT a fresh answer (maxAgeSeconds)", async () => {
    const r = await callOnce({ body: JSON.stringify({ symbol: "ADA", price: 1, updatedAt: "2999-01-01T00:00:00Z" }) });
    expect(r.status).toBe(422);
  });

  it("100 concurrent buyers against an endless-stream seller: bounded memory, all fail closed, nothing charged", async () => {
    seller.setReply(() => "stream");
    const tokens = await Promise.all(Array.from({ length: 100 }, () => insertActiveToken(h.sql, s, 1)));
    global.gc?.();
    const rss0 = process.memoryUsage().rss;
    let peak = rss0;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    const rs = await Promise.all(tokens.map((t) => srv.req(`/a/${s.apiId}/x/getPrice?symbol=ADA`, { headers: { authorization: `Bearer ${t.token}` } }).then((r) => r.status)));
    clearInterval(timer);
    const [{ left }] = await h.sql<{ left: number }[]>`select sum(remaining)::int as left from credit_tokens where id = any(${tokens.map((t) => t.id)})`;
    expect(left).toBe(100);
    expect(rs.every((x) => x === 502 || x === 504), JSON.stringify(tally(rs))).toBe(true);
    // 100 x 1 MB cap; allow generous headroom for the test process itself (stub seller lives here too).
    expect((peak - rss0) / 1e6).toBeLessThan(600);
  });

  it("a raw-socket seller with 10k response headers or a broken status line fails closed", async () => {
    const raw = net.createServer((c) => {
      c.on("error", () => {});
      c.once("data", () => {
        const mode = rawMode;
        if (mode === "headers") c.end("HTTP/1.1 200 OK\r\n" + Array.from({ length: 10_000 }, (_, i) => `x-h${i}: v\r\n`).join("") + `content-type: application/json\r\n\r\n${passingBody()}`);
        else if (mode === "status") c.end(`HTTP/1.1 2OO OK\r\ncontent-type: application/json\r\n\r\n${passingBody()}`);
        else if (mode === "nul-ct") c.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\x00evil\r\ncontent-length: ${passingBody().length}\r\n\r\n${passingBody()}`);
        else c.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 5\r\n\r\n${passingBody()}`);
      });
    });
    let rawMode = "headers";
    await new Promise<void>((r) => raw.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(raw.address() as net.AddressInfo).port}`;
    const api = await seedLiveApi(h.sql, origin);
    const out: string[] = [];
    for (const m of ["headers", "status", "nul-ct", "short-cl"]) {
      rawMode = m;
      const { token, id } = await insertActiveToken(h.sql, api, 1);
      const r = await srv.req(`/a/${api.apiId}/x/getPrice?symbol=ADA`, { headers: { authorization: `Bearer ${token}` } });
      const [row] = await h.sql<{ remaining: number }[]>`select remaining from credit_tokens where id = ${id}`;
      out.push(`${m}=${r.status}/left${row!.remaining}`);
    }
    raw.close();
    expect(out.filter((x) => !/=(4\d\d|502|504)\/left1$/.test(x)), out.join(" ")).toEqual([]);
  });
});

describe("the sealed key never reaches a buyer", () => {
  const KEY = "hkfake_Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0L";
  const forms: [string, (k: string) => string][] = [
    ["raw", (k) => k],
    ["upper", (k) => k.toUpperCase()],
    ["json-escaped unicode", (k) => [...k].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")],
    ["base64", (k) => Buffer.from(k).toString("base64")],
    ["base64url", (k) => Buffer.from(k).toString("base64url")],
    ["double base64", (k) => Buffer.from(Buffer.from(k).toString("base64")).toString("base64")],
    ["percent all", (k) => [...k].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")],
    ["html decimal", (k) => [...k].map((c) => `&#${c.charCodeAt(0)};`).join("")],
    ["hex", (k) => Buffer.from(k).toString("hex")],
    ["echoed URL", (k) => `https://x.test/price?symbol=ADA&api_key=${encodeURIComponent(k)}`],
    ["mime-wrapped base64", (k) => Buffer.from(`prefix-${k}-suffix`).toString("base64").replace(/(.{8})/g, "$1\n")],
    ["reversed", (k) => [...k].reverse().join("")],
    ["zero-width split", (k) => [...k].join("​")],
    ["triple base64", (k) => Buffer.from(Buffer.from(Buffer.from(k).toString("base64")).toString("base64")).toString("base64")],
    ["utf-16 hex", (k) => Buffer.from(k, "utf16le").toString("hex")],
  ];
  /** Forms a real careless API produces (echoing its request, logging, JSON writers). These must be caught. */
  const MUST_CATCH = new Set([
    "raw", "upper", "json-escaped unicode", "base64", "base64url", "double base64", "percent all", "html decimal", "hex", "echoed URL",
    "mime-wrapped base64", "zero-width split", "utf-16 hex",
  ]);

  it("each encoding of the key in an otherwise passing answer: withheld, no credit; exotic ones listed", async () => {
    const keys = generateUpstreamAuthKeys();
    const hk = await makeHarness({ config: { upstreamTimeoutMs: 1_500, upstreamAuthPrivateKey: keys.privateKey } });
    const keyed = await startHostileSeller();
    const api = await seedLiveApi(hk.sql, keyed.origin);
    const sealed = sealUpstreamSecret(keys.publicKey, { apiId: api.apiId, in: "query", name: "api_key", origin: keyed.origin, pathPrefix: "/" }, KEY);
    await hk.sql`update apis set upstream_auth = ${hk.sql.json({ in: "query", name: "api_key", sealed, hint: KEY.slice(-4) })} where id = ${api.apiId}`;
    const app = createApp({ ...hk.deps, registry: new ApiRegistry(hk.sql, hk.health, keys.privateKey) });
    const s2 = await serve(app);
    const leaked: string[] = [];
    const missed: string[] = [];
    try {
      for (const [name, enc] of forms) {
        keyed.setReply((req) => {
          const sent = new URL(req.url ?? "/", "http://x").searchParams.get("api_key");
          if (sent !== KEY) return { status: 401, body: "{}" };
          return { body: JSON.stringify({ symbol: "ADA", price: 0.42, updatedAt: new Date().toISOString(), debug: enc(KEY) }) };
        });
        const { token, id } = await insertActiveToken(hk.sql, api, 1);
        const r = await s2.req(`/a/${api.apiId}/x/getPrice?symbol=ADA`, { headers: { authorization: `Bearer ${token}` } });
        const [row] = await hk.sql<{ remaining: number }[]>`select remaining from credit_tokens where id = ${id}`;
        if (r.status === 200) (MUST_CATCH.has(name) ? leaked : missed).push(name);
        else expect(row!.remaining).toBe(1);
        expect(r.text.includes(KEY)).toBe(false);
      }
      const reasons = await hk.sql<{ r: string }[]>`select verdict_reasons::text as r from calls where api_id = ${api.apiId}`;
      expect(reasons.filter((x) => x.r.includes(KEY))).toEqual([]);
    } finally {
      await s2.close(); await keyed.close(); await hk.close();
    }
    if (missed.length) console.warn(`[stress] key encodings passed on to the buyer (documented limit, defence in depth): ${missed.join(", ")}`);
    expect(leaked).toEqual([]);
  });
});

describe("SSRF: origins that point inside the network are never contacted (strict mode)", () => {
  it("loopback, metadata, private, mapped and odd IP spellings are blocked before any connection", async () => {
    const prev = process.env.ALLOW_INSECURE_UPSTREAM;
    process.env.ALLOW_INSECURE_UPSTREAM = "0";
    const listener = net.createServer((c) => { hits += 1; c.destroy(); });
    let hits = 0;
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
    const port = (listener.address() as net.AddressInfo).port;
    const origins = [
      `https://127.0.0.1:${port}`, `https://localhost:${port}`, `https://127.1:${port}`, `https://2130706433:${port}`,
      `https://0x7f000001:${port}`, `https://0177.0.0.1:${port}`, `https://[::ffff:127.0.0.1]:${port}`, `https://[::ffff:7f00:1]:${port}`,
      `https://[::1]:${port}`, `https://[0:0:0:0:0:0:0:1]:${port}`, `https://169.254.169.254`, `https://[fd00::1]`, `https://10.0.0.1`,
      `https://192.168.1.1`, `https://100.64.0.1`, `https://0.0.0.0:${port}`, `https://[::]:${port}`, `http://127.0.0.1:${port}`,
      `https://user:pw@127.0.0.1:${port}`, `https://127.0.0.1.:${port}`, `https://LOCALHOST:${port}`, `https://localhost.:${port}`,
    ];
    const out: string[] = [];
    try {
      for (const origin of origins) {
        const api = await seedLiveApi(h.sql, origin, { pathPrefix: anotherBase() });
        const { token } = await insertActiveToken(h.sql, api, 1);
        const r = await srv.req(`/a/${api.apiId}/x/getPrice?symbol=ADA`, { headers: { authorization: `Bearer ${token}` } });
        const [call] = await h.sql<{ execution: string }[]>`select execution from calls where api_id = ${api.apiId} order by created_at desc limit 1`;
        out.push(`${origin} -> ${r.status} ${call?.execution ?? "no-call"}`);
      }
    } finally {
      process.env.ALLOW_INSECURE_UPSTREAM = prev;
      listener.close();
    }
    expect(hits, out.join("\n")).toBe(0);
    expect(out.filter((x) => / 200 /.test(x))).toEqual([]);
  });
});
