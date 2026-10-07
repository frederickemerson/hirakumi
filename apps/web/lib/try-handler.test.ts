import { outputHash } from "@hirakumi/core";
import { describe, expect, it } from "vitest";
import { createBuyHandler } from "./try-buy";
import { createReceiptsHandler, createTryHandler, visitorKey } from "./try-handler";
import type { BudgetSlot, TryPack } from "./try-repo";
import { readBuyEvents } from "./try-stream";

describe("visitorKey (audit M1)", () => {
  const req = (headers: Record<string, string>) => new Request("https://web.hirakumi.test/api/try/api_1", { method: "POST", headers });
  it("uses x-real-ip, which Vercel sets, over a client-supplied x-forwarded-for", () => {
    expect(visitorKey(req({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "10.0.0.1, 203.0.113.5" }))).toBe("203.0.113.5");
  });
  it("falls back to the left-most x-forwarded-for, then to one shared key", () => {
    expect(visitorKey(req({ "x-forwarded-for": " 198.51.100.4 , 10.0.0.1" }))).toBe("198.51.100.4");
    expect(visitorKey(req({}))).toBe("unknown");
  });
});

type Call = { url: string; init: RequestInit };

const PACK: TryPack = {
  token: "hk_live_token", creditTokenId: "ct_live1", remaining: 98, pending: false, txHash: "ab".repeat(32),
  boughtAt: new Date("2026-10-06T10:00:00Z"), source: "live",
};

function setup(reply: () => Response, opts: { pack?: TryPack | null; allow?: () => boolean; budget?: () => Promise<BudgetSlot> } = {}) {
  const calls: Call[] = [];
  const handle = createTryHandler({
    gatewayBase: "https://gw.test",
    pack: async () => (opts.pack === undefined ? PACK : opts.pack),
    allow: opts.allow ?? (() => true),
    budget: opts.budget ?? (async () => ({ ok: true as const, release: async () => {} })),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return reply();
    }) as unknown as typeof fetch,
    now: (() => { let t = 0; return () => (t += 40); })(),
  });
  return { calls, handle };
}

const req = (body: unknown, ip = "1.2.3.4") =>
  new Request("http://web.test/api/try/api_1", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

describe("try handler", () => {
  it("pays with the live pack's token and returns the answer with its receipt", async () => {
    const answer = '{"price":0.31}';
    const { calls, handle } = setup(() => new Response(answer, { status: 200, headers: { "x-credits-remaining": "97", "content-type": "application/json" } }));
    const res = await handle(req({ opId: "getPrice", method: "GET", input: { symbol: "ADA" } }), "api_1");
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ status: 200, creditsRemaining: 97, latencyMs: 40, body: { price: 0.31 }, result: { kind: "kept" } });
    expect(out.receipt).toEqual({
      verdict: "kept", creditsLeft: 97, outputHash: outputHash("ct_live1", answer), receiptsUrl: "/api/try/api_1/receipts",
    });
    expect(calls[0].url).toBe("https://gw.test/a/api_1/x/getPrice?symbol=ADA");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer hk_live_token");
    expect(JSON.stringify(out)).not.toContain("hk_live_token");
  });

  it("a broken promise is a receipt with no charge and no output hash", async () => {
    const { handle } = setup(() => new Response('{"error":"promise_not_met","reasons":["price is old"]}', { status: 422, headers: { "x-credits-remaining": "98" } }));
    const out = await (await handle(req({ opId: "getPrice", method: "GET", input: {} }), "api_1")).json();
    expect(out.receipt).toMatchObject({ verdict: "not_kept", creditsLeft: 98, outputHash: null });
  });

  it("always pays: there is no unpaid mode, even if a client asks for one", async () => {
    const { calls, handle } = setup(() => new Response("{}", { status: 200 }));
    await handle(req({ opId: "getPrice", method: "GET", input: {}, paid: false }), "api_1");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer hk_live_token");
  });

  it("without a pack asks for a live purchase and never calls the gateway", async () => {
    const { calls, handle } = setup(() => new Response("{}"), { pack: null });
    const res = await handle(req({ opId: "getPrice", method: "GET", input: {} }), "api_1");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "No pack with credits yet. Buy one live first.", needsPack: true });
    expect(calls).toHaveLength(0);
  });

  it("rate-limits calls per visitor", async () => {
    const { calls, handle } = setup(() => new Response("{}"), { allow: () => false });
    const res = await handle(req({ opId: "getPrice", method: "GET", input: {} }), "api_1");
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("rate-limits before it looks up the pack, so throttled requests cost no query", async () => {
    let lookups = 0;
    const handle = createTryHandler({
      gatewayBase: "https://gw.test", pack: async () => (lookups++, PACK), allow: () => false, budget: async () => ({ ok: true as const, release: async () => {} }),
      fetchImpl: (() => { throw new Error("no"); }) as unknown as typeof fetch,
    });
    expect((await handle(req({ opId: "getPrice", method: "GET", input: {} }), "api_1")).status).toBe(429);
    expect(lookups).toBe(0);
  });

  it("refuses once the pack's hourly budget is used, without calling the gateway (audit: drain)", async () => {
    const { calls, handle } = setup(() => new Response("{}"), { budget: async () => ({ ok: false as const, problem: "This pack has made its calls for this hour. Try again later." }) });
    const res = await handle(req({ opId: "getPrice", method: "GET", input: {} }), "api_1");
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/this hour/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a cross-site call", async () => {
    const { handle } = setup(() => new Response("{}"));
    const r = new Request("http://web.test/api/try/api_1", {
      method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ opId: "getPrice", method: "GET", input: {} }),
    });
    expect((await handle(r, "api_1")).status).toBe(403);
  });

  it("rejects malformed requests", async () => {
    const { handle } = setup(() => new Response("{}"));
    expect((await handle(req({ opId: "", method: "GET", input: {} }), "api_1")).status).toBe(400);
    expect((await handle(req({ opId: "x", method: "TRACE", input: {} }), "api_1")).status).toBe(400);
    expect((await handle(req({ opId: "x", method: "GET", input: [] }), "api_1")).status).toBe(400);
  });

  it("reports an unreachable gateway without throwing", async () => {
    const { handle } = setup(() => { throw new Error("ECONNREFUSED"); });
    expect((await handle(req({ opId: "getPrice", method: "GET", input: {} }), "api_1")).status).toBe(502);
  });

  it("keeps a paid text answer as text, even one that would parse as JSON, and says its type", async () => {
    const csv = "date,usd\n2026-10-07,0.27\n";
    const { handle } = setup(() => new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } }));
    const out = await (await handle(req({ opId: "getPrice", method: "GET", input: {} }), "api_1")).json();
    expect(out).toMatchObject({ body: csv, contentType: "text/csv", result: { kind: "kept" } });
    expect(out.receipt.outputHash).toBe(outputHash("ct_live1", csv));
    const { handle: h2 } = setup(() => new Response("42", { status: 200, headers: { "content-type": "text/plain" } }));
    expect((await (await h2(req({ opId: "getPrice", method: "GET", input: {} }), "api_1")).json()).body).toBe("42");
  });

  it("still reads the gateway's JSON reasons on a refused text answer", async () => {
    const { handle } = setup(() => new Response(JSON.stringify({ error: "promise_not_met", reasons: ["the answer is empty"] }), { status: 422 }));
    const out = await (await handle(req({ opId: "getPrice", method: "GET", input: {} }), "api_1")).json();
    expect(out.result).toMatchObject({ kind: "not_kept", reasons: ["the answer is empty"] });
  });

  it("asks the gateway for JSON or text", async () => {
    const { calls, handle } = setup(() => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));
    await handle(req({ opId: "getPrice", method: "GET", input: {} }), "api_1");
    expect((calls[0].init.headers as Record<string, string>).accept).toBe("application/json, text/*;q=0.9, */*;q=0.8");
  });

  it("keeps non-JSON bodies as text", async () => {
    const { handle } = setup(() => new Response("plain", { status: 200 }));
    const out = await (await handle(req({ opId: "getPrice", method: "GET", input: {} }), "api_1")).json();
    expect(out.body).toBe("plain");
  });
});

describe("receipts handler", () => {
  it("reads the pack's receipts from the gateway with the server-side token", async () => {
    const seen: Call[] = [];
    const handle = createReceiptsHandler({
      gatewayBase: "https://gw.test", pack: async () => PACK,
      fetchImpl: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return Response.json({ token: { id: "ct_live1" }, calls: [] }); }) as unknown as typeof fetch,
    });
    const res = await handle("api_1");
    expect(await res.json()).toEqual({ token: { id: "ct_live1" }, calls: [] });
    expect(seen[0].url).toBe("https://gw.test/a/api_1/receipts");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bearer hk_live_token");
  });
  it("502, not a crash, when the gateway answers 200 with a body that isn't JSON", async () => {
    const handle = createReceiptsHandler({
      gatewayBase: "https://gw.test", pack: async () => PACK,
      fetchImpl: (async () => new Response("<html>proxy</html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect((await handle("api_1")).status).toBe(502);
  });
  it("404 before any pack was bought", async () => {
    const handle = createReceiptsHandler({ gatewayBase: "https://gw.test", pack: async () => null, fetchImpl: (() => { throw new Error("no"); }) as unknown as typeof fetch });
    expect((await handle("api_1")).status).toBe(404);
  });
});

describe("buy handler", () => {
  const buyReq = (headers: Record<string, string> = {}) => new Request("http://web.test/api/try/api_1/buy", { method: "POST", headers });
  function buyer(reply: () => Response, allow = () => true) {
    const seen: Call[] = [];
    const handle = createBuyHandler({
      gatewayInternalUrl: "https://gw-internal.test/", internalToken: "internal-secret", allow,
      fetchImpl: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return reply(); }) as unknown as typeof fetch,
    });
    return { seen, handle };
  }

  it("asks the gateway's internal route with the bearer token and streams its progress through", async () => {
    const lines = [{ phase: "paying", packId: "pk_1", calls: 100, priceMicros: "2000000", wallet: "addr_test1q" }, { phase: "settling" }, { phase: "settled", txHash: "cd".repeat(32), credits: 100, ms: 21_400, recovered: false }];
    const { seen, handle } = buyer(() => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } }));
    const res = await handle(buyReq(), "api_1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(seen[0].url).toBe("https://gw-internal.test/internal/demo/buy-pack/api_1");
    expect(seen[0].init.method).toBe("POST");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bearer internal-secret");
    const got = [];
    for await (const e of readBuyEvents(res.body!)) got.push(e);
    expect(got).toEqual(lines);
  });

  it("passes the gateway's refusal (limits, low funds) through as a message", async () => {
    const { handle } = buyer(() => Response.json({ error: "low_funds", message: "The demo wallet has 2.5 tADA. It needs at least 3 tADA for fees, so nothing was bought." }, { status: 409 }));
    const res = await handle(buyReq(), "api_1");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The demo wallet has 2.5 tADA. It needs at least 3 tADA for fees, so nothing was bought." });
  });

  it("never reveals an internal auth failure, refuses cross-site posts and rate-limits visitors", async () => {
    expect((await buyer(() => new Response("{}", { status: 401 })).handle(buyReq(), "api_1")).status).toBe(503);
    const cross = buyer(() => new Response("{}"));
    expect((await cross.handle(buyReq({ "sec-fetch-site": "cross-site" }), "api_1")).status).toBe(403);
    expect(cross.seen).toHaveLength(0);
    const limited = buyer(() => new Response("{}"), () => false);
    expect((await limited.handle(buyReq(), "api_1")).status).toBe(429);
    expect(limited.seen).toHaveLength(0);
  });
});

describe("readBuyEvents", () => {
  it("yields events as lines arrive, across chunk boundaries, and skips broken lines", async () => {
    const enc = new TextEncoder();
    const chunks = ['{"phase":"pay', 'ing","packId":"p","calls":1,"priceMicros":"1","wallet":"w"}\nnot json\n{"phase":"settl', 'ing"}'];
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
    const got = [];
    for await (const e of readBuyEvents(body)) got.push(e.phase);
    expect(got).toEqual(["paying", "settling"]);
  });
});
