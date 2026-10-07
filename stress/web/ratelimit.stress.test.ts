// Rate limits under concurrent abuse: Try it live (per visitor + per-pack hourly budget), Buy live, Ask Hirakumi,
//. The gateway, OpenAI and Blockfrost are stubbed; nothing leaves the process.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newBearerToken, newId, sha256Hex } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedPack, seedSeller } from "@/test/factories";
import { cookieFor, ctx } from "@/test/requests";
import { makeTestWallet } from "@/test/wallet-fixture";
import { POST as tryPost } from "@/app/api/try/[apiId]/route";
import { POST as buyPost } from "@/app/api/try/[apiId]/buy/route";
import { POST as askPost } from "@/app/api/ask/route";

const realFetch = globalThis.fetch;
let ipSeq = 0;
/** A fresh documentation-range address per call, so tests in this file never share a limiter bucket. */
const freshIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const tally = (xs: number[]) => xs.reduce<Record<number, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

function tryReq(apiId: string, headers: Record<string, string>): Promise<Response> {
  return tryPost(new Request(`https://web.hirakumi.test/api/try/${apiId}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ opId: "getPrice", method: "GET", input: { symbol: "ADA" } }),
  }), ctx(apiId));
}

describe("Try it live under concurrent abuse", () => {
  let apiId: string;
  let tokenId: string;
  let gatewayCalls = 0;

  beforeEach(async () => {
    await resetDb();
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    apiId = api.id;
    const pack = await seedPack(api.id);
    const token = newBearerToken();
    tokenId = newId("ct");
    await getSql()`insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash)
      values (${tokenId}, ${apiId}, ${pack.id}, ${sha256Hex(token)}, 'active', 1000, ${sha256Hex(tokenId)})`;
    vi.stubEnv("TRY_CREDIT_TOKENS", JSON.stringify({ [apiId]: token }));
    // Public Try it live is the showcase only (TRY_LIVE_APIS).
    vi.stubEnv("TRY_LIVE_APIS", apiId);
    gatewayCalls = 0;
    // The gateway: logs the paid call (what the hourly budget counts) after a short think, then answers 200.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (!u.startsWith("https://api.hirakumi.test/")) return realFetch(url);
      gatewayCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      await getSql()`insert into calls (id, kind, credit_token_id, api_id, op_id, execution, verdict)
        values (${newId("call")}, 'credit', ${tokenId}, ${apiId}, 'getPrice', 'upstream_ok', 'pass')`;
      return new Response(JSON.stringify({ price: 1 }), { status: 200, headers: { "content-type": "application/json", "x-credits-remaining": "999" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("300 concurrent tries from one visitor: exactly one reaches the gateway, the rest are 429", async () => {
    const ip = freshIp();
    const st = await Promise.all(Array.from({ length: 300 }, () => tryReq(apiId, { "x-real-ip": ip }).then((r) => r.status)));
    expect(tally(st)).toEqual({ 200: 1, 429: 299 });
    expect(gatewayCalls).toBe(1);
  });

  it("rotating X-Forwarded-For behind a platform-set X-Real-IP does not escape the per-visitor limit", async () => {
    const ip = freshIp();
    const st = await Promise.all(Array.from({ length: 200 }, (_, i) =>
      tryReq(apiId, { "x-real-ip": ip, "x-forwarded-for": `10.0.${i >> 8}.${i & 255}, ${ip}` }).then((r) => r.status)));
    expect(st.filter((s) => s === 200)).toHaveLength(1);
    expect(gatewayCalls).toBe(1);
  });

  it("cross-site tries are refused before anything is counted", async () => {
    const st = await Promise.all(Array.from({ length: 50 }, () =>
      tryReq(apiId, { "x-real-ip": freshIp(), "sec-fetch-site": "cross-site" }).then((r) => r.status)));
    expect(tally(st)).toEqual({ 403: 50 });
    expect(gatewayCalls).toBe(0);
  });

  it("hostile try bodies (huge, wrong types, opId traversal) never reach the gateway", async () => {
    const bodies: unknown[] = [
      { opId: "../packs/pk_x", method: "GET", input: {} }, // encoded, so it can't leave /x/, but must still be one op id
      { opId: "a".repeat(65), method: "GET", input: {} },
      { opId: "getPrice", method: "TRACE", input: {} },
      { opId: "getPrice", method: "GET", input: [] },
      { opId: "getPrice", method: "GET", input: "x" },
      { opId: ["getPrice"], method: "GET", input: {} },
      { opId: "getPrice", method: "GET", input: { s: "x".repeat(70_000) } },
    ];
    for (const b of bodies) {
      const res = await tryPost(new Request(`https://web.hirakumi.test/api/try/${apiId}`, {
        method: "POST", headers: { "content-type": "application/json", "x-real-ip": freshIp() }, body: JSON.stringify(b),
      }), ctx(apiId));
      expect(res.status, JSON.stringify(b).slice(0, 40)).toBe(b === bodies[0] ? 200 : 400);
    }
    // The traversal op id went to the gateway percent-encoded, inside /x/.
    const urls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => /\/a\/[^/]+\/x\/[^/]+(\?|$)/.test(u.replace("https://api.hirakumi.test", "")))).toBe(true);
  });

  // Fixed: each try reserves a slot (try_call_slots, under a per-pack advisory lock) before the call is sent, so
  // 100 visitors at once (or one visitor across serverless instances) can't overspend the hourly budget.
  it("100 distinct visitors at once cannot spend more than the 30-per-hour pack budget", async () => {
    const st = await Promise.all(Array.from({ length: 100 }, () => tryReq(apiId, { "x-real-ip": freshIp() }).then((r) => r.status)));
    expect(gatewayCalls).toBeLessThanOrEqual(30);
    expect(st.filter((s) => s === 200).length).toBeLessThanOrEqual(30);
  });

  it("sequentially, the budget does hold at 30 per hour", async () => {
    let ok = 0;
    for (let i = 0; i < 35; i++) if ((await tryReq(apiId, { "x-real-ip": freshIp() })).status === 200) ok += 1;
    expect(ok).toBe(30);
  });
});

describe("Buy a pack live under concurrent abuse", () => {
  let buys = 0;
  beforeEach(() => {
    buys = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (!String(url).includes("/internal/demo/buy-pack/")) return realFetch(url);
      buys += 1;
      return new Response('{"step":"done"}\n', { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("200 concurrent buys from one visitor: one reaches the gateway; cross-site buys none", async () => {
    const ip = freshIp();
    const buy = (headers: Record<string, string>) =>
      buyPost(new Request("https://web.hirakumi.test/api/try/api_x/buy", { method: "POST", headers }), ctx("api_x")).then((r) => r.status);
    const st = await Promise.all(Array.from({ length: 200 }, () => buy({ "x-real-ip": ip })));
    expect(tally(st)).toEqual({ 200: 1, 429: 199 });
    const cross = await Promise.all(Array.from({ length: 20 }, () => buy({ "x-real-ip": freshIp(), origin: "https://evil.example" })));
    expect(tally(cross)).toEqual({ 403: 20 });
    expect(buys).toBe(1);
  });
});

describe("Ask Hirakumi under concurrent abuse", () => {
  beforeEach(async () => {
    await resetDb();
    await getSql()`truncate ask_requests`;
    vi.stubEnv("OPENAI_API_KEY", ""); // the offline answer: no model spend, same limiter
  });
  afterEach(() => vi.unstubAllEnvs());

  const ask = (headers: Record<string, string>, body: unknown = { question: "What is Hirakumi?" }) =>
    askPost(new Request("https://web.hirakumi.test/api/ask", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
    }));

  it("150 concurrent questions from one address: exactly 10 answered (limit holds across a burst)", async () => {
    const ip = freshIp();
    const st = await Promise.all(Array.from({ length: 150 }, () => ask({ "x-real-ip": ip }).then(async (r) => { await r.text(); return r.status; })));
    expect(tally(st)).toEqual({ 200: 10, 429: 140 });
  });

  it("a signed-in seller rotating addresses still gets 10", async () => {
    const seller = await seedSeller();
    const st = await Promise.all(Array.from({ length: 60 }, () =>
      ask({ "x-real-ip": freshIp(), cookie: cookieFor(seller) }).then(async (r) => { await r.text(); return r.status; })));
    expect(st.filter((s) => s === 200)).toHaveLength(10);
  });

  it("rotating X-Forwarded-For behind a fixed X-Real-IP still gets 10", async () => {
    const ip = freshIp();
    const st = await Promise.all(Array.from({ length: 60 }, (_, i) =>
      ask({ "x-real-ip": ip, "x-forwarded-for": `10.9.${i}.1` }).then(async (r) => { await r.text(); return r.status; })));
    expect(st.filter((s) => s === 200)).toHaveLength(10);
  });

  it("oversized, malformed and cross-site questions are refused and never counted", async () => {
    const ip = freshIp();
    const cases: [Record<string, string>, unknown, number][] = [
      [{}, { question: "x".repeat(1001) }, 400],
      [{}, JSON.stringify({ question: "hi", pad: "x".repeat(70_000) }), 400],
      [{}, `{"question": "hi", "history": [${'{"role":"user","content":"x"},'.repeat(3000)}{"role":"user","content":"x"}]}`, 400],
      [{}, "{not json", 400],
      [{}, JSON.stringify(["question"]), 400],
      [{}, { question: { $gt: "" } }, 400],
      [{ "sec-fetch-site": "cross-site" }, { question: "hi" }, 403],
    ];
    for (const [h, b, want] of cases) expect((await ask({ "x-real-ip": ip, ...h }, b)).status).toBe(want);
    // A 5 MB body is refused too (and quickly).
    const t0 = performance.now();
    expect((await ask({ "x-real-ip": ip }, JSON.stringify({ question: "hi", pad: "x".repeat(5_000_000) }))).status).toBe(400);
    expect(performance.now() - t0).toBeLessThan(2_000);
    const [{ n }] = await getSql()`select count(*)::int n from ask_requests`;
    expect(n).toBe(0);
  });

  it("a long forged history is capped: the question is still answered", async () => {
    const history = Array.from({ length: 500 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "y".repeat(50) }));
    const res = await ask({ "x-real-ip": freshIp() }, { question: "hi", history });
    expect(res.status).toBe(200);
  });
});

