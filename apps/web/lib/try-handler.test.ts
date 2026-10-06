import { describe, expect, it } from "vitest";
import { createTryHandler } from "./try-handler";

type Call = { url: string; init: RequestInit };

function setup(reply: () => Response, opts: { tokens?: Record<string, string>; allow?: () => boolean; budget?: () => Promise<string | null> } = {}) {
  const calls: Call[] = [];
  const handle = createTryHandler({
    gatewayBase: "https://gw.test",
    tokens: opts.tokens ?? { api_1: "demo-token" },
    allow: opts.allow ?? (() => true),
    budget: opts.budget ?? (async () => null),
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
  it("calls the gateway with the demo credit and reports the kept promise", async () => {
    const { calls, handle } = setup(() => new Response('{"price":0.31}', { status: 200, headers: { "x-credits-remaining": "97", "content-type": "application/json" } }));
    const res = await handle(req({ opId: "getPrice", method: "GET", input: { symbol: "ADA" }, paid: true }), "api_1");
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ status: 200, creditsRemaining: 97, latencyMs: 40, body: { price: 0.31 }, result: { kind: "kept" } });
    expect(calls[0].url).toBe("https://gw.test/a/api_1/x/getPrice?symbol=ADA");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer demo-token");
  });

  it("an unpaid call shows the 402 offer and sends no token", async () => {
    const { calls, handle } = setup(() => new Response('{"accepts":[]}', { status: 402 }));
    const out = await (await handle(req({ opId: "getPrice", method: "GET", input: {}, paid: false }), "api_1")).json();
    expect(out.result.kind).toBe("payment_required");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("refuses a paid call when this API has no demo pack", async () => {
    const { calls, handle } = setup(() => new Response("{}"), { tokens: {} });
    const res = await handle(req({ opId: "getPrice", method: "GET", input: {}, paid: true }), "api_1");
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it("rate-limits paid calls per visitor", async () => {
    const { calls, handle } = setup(() => new Response("{}"), { allow: () => false });
    const res = await handle(req({ opId: "getPrice", method: "GET", input: {}, paid: true }), "api_1");
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("refuses paid tries once the shared demo budget is used up, without calling the gateway (audit: drain)", async () => {
    const { calls, handle } = setup(() => new Response("{}"), { budget: async () => "The demo has used its paid tries for this hour." });
    const res = await handle(req({ opId: "getPrice", method: "GET", input: {}, paid: true }), "api_1");
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/this hour/);
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed requests", async () => {
    const { handle } = setup(() => new Response("{}"));
    expect((await handle(req({ opId: "", method: "GET", input: {} }), "api_1")).status).toBe(400);
    expect((await handle(req({ opId: "x", method: "TRACE", input: {} }), "api_1")).status).toBe(400);
    expect((await handle(req({ opId: "x", method: "GET", input: [] }), "api_1")).status).toBe(400);
  });

  it("reports an unreachable gateway without throwing", async () => {
    const { handle } = setup(() => { throw new Error("ECONNREFUSED"); });
    const res = await handle(req({ opId: "getPrice", method: "GET", input: {}, paid: true }), "api_1");
    expect(res.status).toBe(502);
  });

  it("keeps non-JSON bodies as text", async () => {
    const { handle } = setup(() => new Response("plain", { status: 200 }));
    const out = await (await handle(req({ opId: "getPrice", method: "GET", input: {}, paid: true }), "api_1")).json();
    expect(out.body).toBe("plain");
  });
});
