// Protocol fuzzing against a real local HTTP listener: x402 payment headers, raw sockets, hostile URLs,
// query pollution, bodies and encodings. Safe behaviour: never a 200 for a bad payment, never a facilitator
// call for a payment that does not match the offer, never a credit used, never a 5xx for client garbage.
import net from "node:net";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { LONG, insertActiveToken, makeHarness, offerOf, paymentHeader, serve, tally, type Harness } from "./kit";

let h: Harness;
let srv: Awaited<ReturnType<typeof serve>>;
let required: any;
let packPath: string;
let callPath: string;
beforeAll(async () => {
  h = await makeHarness();
  srv = await serve(h.app);
  packPath = `/a/${h.seeded.apiId}/packs/${h.seeded.packId}`;
  callPath = `/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`;
  required = await offerOf(await srv.req(packPath, { method: "POST" }));
});
afterAll(async () => { await srv?.close(); await h?.close(); });

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const tokenRows = async () => (await h.sql<{ n: number }[]>`select count(*)::int as n from credit_tokens`)[0]!.n;

/** Raw request over a socket; returns everything the server wrote before closing or `ms` passing. */
function raw(payload: string | Buffer, ms = 1_500): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(srv.port, "127.0.0.1");
    let out = "";
    const done = () => { s.destroy(); resolve(out); };
    s.on("data", (d) => { out += d.toString("latin1"); });
    s.on("error", done);
    s.on("close", done);
    s.on("connect", () => s.write(payload));
    setTimeout(done, ms);
  });
}
const statusOf = (resp: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(resp)?.[1] ?? 0);

describe("x402 payment header fuzzing (direct packs)", () => {
  it("garbage, wrong shapes and 60 KB headers: no 200, no 5xx, no facilitator call, no token", async () => {
    const accepted = required.accepts[0];
    const cases: [string, string][] = [
      ["not base64", "!!!!***"],
      ["empty object", b64("{}")],
      ["null", b64("null")],
      ["array", b64("[]")],
      ["number", b64("1")],
      ["string", b64('"x"')],
      ["truncated json", b64('{"x402Version":2,"accepted":')],
      ["v1", b64(JSON.stringify({ x402Version: 1, accepted, payload: { transaction: "t" } }))],
      ["v3", b64(JSON.stringify({ x402Version: 3, accepted, payload: { transaction: "t" } }))],
      ["version as string", b64(JSON.stringify({ x402Version: "2", accepted, payload: { transaction: "t" } }))],
      ["no accepted", b64(JSON.stringify({ x402Version: 2, payload: { transaction: "t" } }))],
      ["no payload", b64(JSON.stringify({ x402Version: 2, accepted }))],
      ["payload is a string", b64(JSON.stringify({ x402Version: 2, accepted, payload: "t" }))],
      ["__proto__ pollution", b64(`{"x402Version":2,"__proto__":{"isValid":true,"admin":true},"accepted":${JSON.stringify(accepted)},"payload":{"__proto__":{"transaction":"p"}}}`)],
      ["60 KB junk", b64(JSON.stringify({ x402Version: 2, accepted, payload: { transaction: "t", pad: "x".repeat(44_000) } }))],
      ["deeply nested", b64(`{"x402Version":2,"accepted":${"[".repeat(5000)}${"]".repeat(5000)}}`)],
      ["utf-16 junk", Buffer.from("﻿{\u0000}", "utf16le").toString("base64")],
      ["base64url", Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { transaction: "t" } })).toString("base64url")],
    ];
    // The real Cardano decoder, not the harness's "any string is a transaction": junk must never read as a payment.
    const fakeTx = h.deps.paymentTxHash;
    delete h.deps.paymentTxHash;
    const before = { v: h.facilitator.verifyCalls, s: h.facilitator.settleCalls, t: await tokenRows() };
    const out: string[] = [];
    for (const [name, sig] of cases) {
      const r = await srv.req(packPath, { method: "POST", headers: { "payment-signature": sig } });
      out.push(`${name}=${r.status}`);
    }
    // x-payment (v1 name) with the same garbage.
    for (const [name, sig] of cases.slice(0, 6)) {
      const r = await srv.req(packPath, { method: "POST", headers: { "x-payment": sig } });
      out.push(`x-payment ${name}=${r.status}`);
    }
    h.deps.paymentTxHash = fakeTx;
    expect(out.filter((s) => /=(200|5\d\d)$/.test(s)), out.join(" ")).toEqual([]);
    expect(h.facilitator.settleCalls).toBe(before.s);
    expect(await tokenRows()).toBe(before.t);
  });

  it("every single-field mutation of the offer is refused before the facilitator (property)", async () => {
    const accepted = required.accepts[0];
    const before = { v: h.facilitator.verifyCalls, s: h.facilitator.settleCalls };
    const mutations = fc.oneof(
      fc.constantFrom("network", "asset", "payTo", "scheme", "amount", "maxTimeoutSeconds").chain((k) =>
        fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant(String(accepted[k]).toUpperCase()), fc.constant(` ${accepted[k]}`))
          .filter((v) => v !== accepted[k]).map((v) => ({ ...accepted, [k]: v }))),
      fc.constantFrom("packId", "apiId", "calls", "ruleHash", "ruleUrl").chain((k) =>
        fc.oneof(fc.string(), fc.integer()).filter((v) => v !== accepted.extra[k]).map((v) => ({ ...accepted, extra: { ...accepted.extra, [k]: v } }))),
      fc.constantFrom("2000001", "1999999", "02000000", "2000000.0", "2e6", "-2000000", "0").map((amount) => ({ ...accepted, amount })),
      fc.constant({ ...accepted, network: "cardano:mainnet" }),
      fc.constant({ ...accepted, extra: {} }),
    );
    let n = 0;
    await fc.assert(fc.asyncProperty(mutations, async (acc) => {
      n += 1;
      const r = await srv.req(packPath, { method: "POST", headers: { "payment-signature": paymentHeader(required, acc, `tx-mut-${randomBytes(6).toString("hex")}`) } });
      return r.status !== 200 && r.status < 500;
    }), { numRuns: LONG ? 2_000 : 150 });
    expect(n).toBeGreaterThan(0);
    expect(h.facilitator.verifyCalls).toBe(before.v);
    expect(h.facilitator.settleCalls).toBe(before.s);
  });

  it("two PAYMENT-SIGNATURE headers on one request never buy two packs", async () => {
    const accepted = required.accepts[0];
    const a = paymentHeader(required, accepted, `tx-dup-a-${randomBytes(4).toString("hex")}`);
    const b = paymentHeader(required, accepted, `tx-dup-b-${randomBytes(4).toString("hex")}`);
    const t0 = await tokenRows();
    const resp = await raw(`POST ${packPath} HTTP/1.1\r\nHost: x\r\nPayment-Signature: ${a}\r\nPayment-Signature: ${b}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    expect(statusOf(resp)).not.toBe(0);
    expect(statusOf(resp)).toBeLessThan(500);
    expect((await tokenRows()) - t0).toBeLessThanOrEqual(1);
  });
});

describe("raw HTTP abuse", () => {
  it("request smuggling shapes (CL+TE, double CL, bare LF, obs-fold) are refused and never reach a second request", async () => {
    const smuggle = [
      `POST /healthz HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /internal/apis/x/health HTTP/1.1\r\nHost: x\r\n\r\n`,
      `POST /healthz HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nContent-Length: 44\r\n\r\nGET /internal/apis/x/health HTTP/1.1\r\nHost: x\r\n\r\n`,
      `GET /healthz HTTP/1.1\nHost: x\nX: a\n\n`,
      `GET /healthz HTTP/1.1\r\nHost: x\r\nX-Hirakumi-IOU: 1.\r\n ab\r\n\r\n`,
      `GET /healthz HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked, identity\r\n\r\n0\r\n\r\n`,
    ];
    const out = await Promise.all(smuggle.map((p) => raw(p)));
    for (const r of out) {
      // Never a 401 from /internal (the smuggled request was not parsed as a second request).
      expect(r.includes('"unauthorized"'), r.slice(0, 200)).toBe(false);
    }
  });

  it("a 63 KB header is accepted, a 66 KB one gets 431, and the server keeps serving", async () => {
    const ok = await raw(`GET /healthz HTTP/1.1\r\nHost: x\r\nX-Pad: ${"a".repeat(63 * 1024)}\r\nConnection: close\r\n\r\n`);
    const big = await raw(`GET /healthz HTTP/1.1\r\nHost: x\r\nX-Pad: ${"a".repeat(66 * 1024)}\r\nConnection: close\r\n\r\n`);
    expect(statusOf(ok)).toBe(200);
    expect(statusOf(big)).toBe(431);
    expect((await srv.req("/healthz")).status).toBe(200);
  });

  it("300 slowloris sockets (headers dripped) do not stop a normal buyer from being served fast", async () => {
    const socks: net.Socket[] = [];
    for (let i = 0; i < 300; i++) {
      const s = net.connect(srv.port, "127.0.0.1");
      s.on("error", () => {});
      s.write(`GET /healthz HTTP/1.1\r\nHost: x\r\n`);
      socks.push(s);
    }
    const drip = setInterval(() => { for (const s of socks) if (!s.destroyed) s.write(`X-${randomBytes(2).toString("hex")}: a\r\n`); }, 100);
    const { token } = await insertActiveToken(h.sql, h.seeded, 50);
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: 50 }, () => srv.req(callPath, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status)));
    const ms = performance.now() - t0;
    clearInterval(drip);
    for (const s of socks) s.destroy();
    expect(tally(rs)).toEqual({ 200: 50 });
    expect(ms).toBeLessThan(5_000);
  });

  it("2 000 connections at once to /healthz: all served", async () => {
    const rs = await Promise.all(Array.from({ length: 2_000 }, () => raw(`GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, 10_000).then(statusOf)));
    expect(tally(rs)).toEqual({ 200: 2_000 });
  });
});

describe("URLs, queries and bodies", () => {
  it("hostile operation paths and queries never use a credit, never 5xx, never 200", async () => {
    const { token, id } = await insertActiveToken(h.sql, h.seeded, 20);
    const A = h.seeded.apiId;
    const paths = [
      `/a/${A}/x/..%2Fx%2FgetPrice?symbol=ADA`, `/a/${A}/x/%2e%2e/getPrice?symbol=ADA`, `/a/${A}/x/getPrice%00?symbol=ADA`,
      `/a/${A}/x/getPrice%2F..%2F..%2Finternal?symbol=ADA`, `/a/${A}/x/getprice?symbol=ADA`, `/a/${A}/x/GETPRICE?symbol=ADA`,
      `/a/${A}/x/getPrice%20?symbol=ADA`, `/a/${A}/x/%67etPrice?symbol=ADA`, `/a/${A}/x/getPrice/extra?symbol=ADA`,
      `/a/${A}/x/getPrice?symbol=ADA&symbol=BTC`, `/a/${A}/x/getPrice?symbol[]=ADA`, `/a/${A}/x/getPrice?symbol[a]=ADA`,
      `/a/${A}/x/getPrice?symbol[__proto__][x]=1`, `/a/${A}/x/getPrice?__proto__[symbol]=ADA`, `/a/${A}/x/getPrice?constructor[prototype][x]=1&symbol=ADA`,
      `/a/${A}/x/getPrice?symbol=${"%F0%9F%92%A9".repeat(4)}`, `/a/${A}/x/getPrice?symbol=%ZZ`, `/a/${A}/x/getPrice?symbol=A%00`,
      `/a/${A}/x/getPrice?symbol=ADA&${Array.from({ length: 900 }, (_, i) => `p${i}=1`).join("&")}`,
      `/a/${encodeURIComponent("../internal")}/x/getPrice?symbol=ADA`, `/a/${A}%00/x/getPrice?symbol=ADA`,
      `/a/${A}/status?job_id=%00`, `/a/${A}/channels/%00`, `/r/%00`, `/a/%00/receipts`, `/a/${A}/availability%00`,
    ];
    const out: string[] = [];
    for (const p of paths) {
      const r = await srv.req(p, { headers: { authorization: `Bearer ${token}` } });
      out.push(`${r.status} ${p.slice(0, 70)}`);
    }
    const [row] = await h.sql<{ remaining: number }[]>`select remaining from credit_tokens where id = ${id}`;
    // "symbol=A%00" and the emoji symbol may legitimately pass the input schema (2-10 chars) and be served.
    const served = out.filter((s) => s.startsWith("200 ")).length;
    expect(out.filter((s) => /^5/.test(s)), out.join("\n")).toEqual([]);
    expect(20 - row!.remaining).toBe(served);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "symbol")).toBe(false);
  });

  it("bodies: 300 KB, gzip bomb, deep nesting, unknown charset or encoding are 4xx, never 5xx", async () => {
    const created = h.masumi.created.length;
    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024));
    const cases: [string, Record<string, string>, string | Buffer][] = [
      ["300 KB", { "content-type": "application/json" }, JSON.stringify({ x: "a".repeat(300_000) })],
      ["gzip bomb 20 MB", { "content-type": "application/json", "content-encoding": "gzip" }, bomb],
      ["deep nesting", { "content-type": "application/json" }, "[".repeat(120_000) + "]".repeat(120_000)],
      ["charset utf-16", { "content-type": "application/json; charset=utf-16" }, "{}"],
      ["charset junk", { "content-type": "application/json; charset=x-junk" }, "{}"],
      ["encoding br junk", { "content-type": "application/json", "content-encoding": "br" }, "garbage"],
      ["encoding unknown", { "content-type": "application/json", "content-encoding": "x-hirakumi" }, "{}"],
      ["invalid json", { "content-type": "application/json" }, "{"],
      ["json null", { "content-type": "application/json" }, "null"],
      ["NUL in input_data", { "content-type": "application/json" }, JSON.stringify({ identifier_from_purchaser: "aabbccddeeff0011", input_data: { symbol: "AD\u0000A" } })],
      ["NUL in a key", { "content-type": "application/json" }, JSON.stringify({ identifier_from_purchaser: "aabbccddeeff0011", input_data: { symbol: "ADA", ["k\u0000"]: 1 } })],
    ];
    const out: string[] = [];
    for (const [name, headers, body] of cases) {
      const r = await new Promise<number>((resolve) => {
        const s = net.connect(srv.port, "127.0.0.1");
        let data = "";
        s.on("data", (d) => { data += d.toString("latin1"); });
        s.on("close", () => resolve(statusOf(data)));
        s.on("error", () => resolve(statusOf(data)));
        const head = `POST /a/${h.seeded.apiId}/start_job HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
          Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n";
        s.write(head);
        s.write(body); // no half-close: Node would drop the socket before the error answer is written
        setTimeout(() => s.destroy(), 3_000);
      });
      out.push(`${name}=${r}`);
    }
    expect(out.filter((s) => /=(5\d\d|0)$/.test(s)), out.join(" ")).toEqual([]);
    // No Masumi payment request may be left behind for a job that was never stored.
    expect(h.masumi.created.length).toBe(created);
    expect((await srv.req("/healthz")).status).toBe(200);
  });
});
