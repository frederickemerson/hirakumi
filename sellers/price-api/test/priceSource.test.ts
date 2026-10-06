import { describe, it, expect, vi } from "vitest";
import { createPriceSource, isSupportedSymbol, PriceUnavailableError, type FetchLike } from "../src/priceSource.js";

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

  it("never invents a price: with no real quote yet, failing sources mean PriceUnavailableError", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("slow down", { status: 429 }));
    const onError = vi.fn();
    const src = createPriceSource({ fetch, now: () => NOW, onError });
    await expect(src.get("ADA")).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(onError).toHaveBeenCalledTimes(2); // CoinGecko, then Coinbase
  });

  it("serves the last real quote with its real timestamp when CoinGecko fails later", async () => {
    let now = NOW;
    let fail = false;
    const fetch = vi.fn<FetchLike>(async () =>
      fail ? new Response("slow down", { status: 429 }) : new Response(JSON.stringify(cgBody), { status: 200 }));
    const src = createPriceSource({ fetch, now: () => now });
    const good = await src.get("ADA");
    fail = true;
    now += 10 * 60_000;
    expect(await src.get("ADA")).toEqual(good);
  });

  it("treats a body missing fields and a thrown fetch as failures too", async () => {
    await expect(createPriceSource({ fetch: okFetch({ cardano: { usd: 0.27 } }), now: () => NOW }).get("ADA")).rejects.toBeInstanceOf(PriceUnavailableError);
    const throwing = vi.fn<FetchLike>(async () => { throw new Error("timeout"); });
    await expect(createPriceSource({ fetch: throwing, now: () => NOW }).get("BTC")).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  it("backs off for the cache window after a failure instead of hammering CoinGecko", async () => {
    let now = NOW;
    const fetch = vi.fn<FetchLike>(async () => new Response("slow down", { status: 429 }));
    const src = createPriceSource({ fetch, now: () => now });
    await src.get("ADA").catch(() => undefined);
    const afterFirst = fetch.mock.calls.length;
    now += 5_000;
    await src.get("ADA").catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(afterFirst);
  });

  it("uses Coinbase's last trade (real trade time) when CoinGecko fails", async () => {
    const fetch = vi.fn<FetchLike>(async (url: string) => {
      if (url.includes("coingecko")) return new Response("slow down", { status: 429 });
      if (url.endsWith("/products/ADA-USD/ticker")) return new Response(JSON.stringify({ price: "0.27811", time: "2026-10-06T09:55:05.549Z" }), { status: 200 });
      if (url.endsWith("/products/ADA-USD/stats")) return new Response(JSON.stringify({ open: "0.27159", last: "0.27797" }), { status: 200 });
      return new Response("?", { status: 404 });
    });
    const q = await createPriceSource({ fetch, now: () => NOW }).get("ADA");
    expect(q).toEqual({ symbol: "ADA", usd: 0.27811, change24h: 2.4, timestamp: "2026-10-06T09:55:05.549Z", source: "coinbase" });
  });

  it("is unavailable only when every real source fails", async () => {
    const fetch = vi.fn<FetchLike>(async (url: string) =>
      url.includes("coinbase") ? new Response(JSON.stringify({ price: "x" }), { status: 200 }) : new Response("no", { status: 500 }));
    await expect(createPriceSource({ fetch, now: () => NOW }).get("ADA")).rejects.toBeInstanceOf(PriceUnavailableError);
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
