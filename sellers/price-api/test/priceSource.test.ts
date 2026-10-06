import { describe, it, expect, vi } from "vitest";
import { createPriceSource, isSupportedSymbol, type FetchLike } from "../src/priceSource.js";

const NOW = Date.UTC(2026, 9, 6, 8, 0, 0);
const cgBody = { cardano: { usd: 0.269505, usd_24h_change: 1.2466066400317077, last_updated_at: 1791262510 } };
const okFetch = (body: unknown = cgBody) =>
  vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

describe("priceSource", () => {
  it("maps a CoinGecko simple/price row to a quote", async () => {
    const fetch = okFetch();
    const src = createPriceSource({ fetch, now: () => NOW });
    const q = await src.get("ADA");
    expect(q).toEqual({ symbol: "ADA", usd: 0.269505, change24h: 1.25, timestamp: new Date(1791262510 * 1000).toISOString(), source: "coingecko" });
    const url = fetch.mock.calls[0][0];
    expect(url).toContain("ids=cardano");
    expect(url).toContain("include_24hr_change=true");
    expect(url).toContain("include_last_updated_at=true");
  });

  it("caches for 30 seconds", async () => {
    let now = NOW;
    const fetch = okFetch();
    const src = createPriceSource({ fetch, now: () => now });
    await src.get("ADA");
    now += 29_000;
    await src.get("ADA");
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 2_000;
    await src.get("ADA");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to a deterministic quote stamped now when CoinGecko rate-limits", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("slow down", { status: 429 }));
    const onError = vi.fn();
    const src = createPriceSource({ fetch, now: () => NOW, onError });
    const q = await src.get("ADA");
    expect(q).toEqual({ symbol: "ADA", usd: 0.5, change24h: 0, timestamp: new Date(NOW).toISOString(), source: "fallback" });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("falls back when the body is missing fields", async () => {
    const src = createPriceSource({ fetch: okFetch({ cardano: { usd: 0.27 } }), now: () => NOW });
    expect((await src.get("ADA")).source).toBe("fallback");
  });

  it("falls back when fetch throws (timeout, DNS)", async () => {
    const src = createPriceSource({ fetch: vi.fn<FetchLike>(async () => { throw new Error("timeout"); }), now: () => NOW });
    expect((await src.get("BTC")).usd).toBe(60000);
  });

  it("sends the demo API key header when configured", async () => {
    const fetch = okFetch();
    await createPriceSource({ fetch, now: () => NOW, coingeckoApiKey: "CG-test" }).get("ADA");
    const init = fetch.mock.calls[0][1];
    expect(new Headers(init?.headers).get("x-cg-demo-api-key")).toBe("CG-test");
  });

  it("knows its symbols", () => {
    expect(isSupportedSymbol("ADA")).toBe(true);
    expect(isSupportedSymbol("DOGE")).toBe(false);
  });
});
