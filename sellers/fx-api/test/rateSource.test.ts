import { describe, it, expect, vi } from "vitest";
import { createRateSource, isSupportedCurrency, RateUnavailableError, roundRate, type FetchLike } from "../src/rateSource.js";

const NOW = Date.UTC(2026, 9, 7, 8, 0, 0);
const ALL = { EUR: "0.912345", GBP: "0.78", JPY: "148.2312", SGD: "1.34", CHF: "0.88", AUD: "1.52", CAD: "1.37", INR: "83.4", CNY: "7.24", HKD: "7.81", KRW: "1380.5" };
const coinbaseBody = (currency = "USD", rates: Record<string, string> = ALL) => ({ data: { currency, rates: { ...rates, BTC: "0.0000081", ADA: "3.79" } } });
const erBody = { result: "success", time_last_update_unix: 1791331352, rates: Object.fromEntries(Object.entries(ALL).map(([k, v]) => [k, Number(v)])) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okFetch = () => vi.fn<FetchLike>(async () => json(coinbaseBody()));

describe("rateSource", () => {
  it("callers that arrive while the first fetch runs wait for it instead of failing (cold start)", async () => {
    const fetch = okFetch();
    const src = createRateSource({ fetch, now: () => NOW });
    const tables = await Promise.all([src.get("USD"), src.get("USD"), src.get("USD")]);
    expect(new Set(tables.map((t) => t.asOf)).size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps Coinbase's exchange rates for the base, dated when they were fetched", async () => {
    const fetch = okFetch();
    const t = await createRateSource({ fetch, now: () => NOW }).get("USD");
    expect(t.source).toBe("coinbase");
    expect(t.asOf).toBe(new Date(NOW).toISOString());
    expect(t.rates.USD).toBe(1);
    expect(t.rates.EUR).toBe(0.912345);
    expect(t.rates.KRW).toBe(1380.5);
    expect(Object.keys(t.rates)).toHaveLength(12);
    expect(fetch.mock.calls[0][0]).toBe("https://api.coinbase.com/v2/exchange-rates?currency=USD");
  });

  it("caches each base for 30 seconds", async () => {
    let now = NOW;
    const fetch = vi.fn<FetchLike>(async (url: string) => json(coinbaseBody(new URL(url).searchParams.get("currency") ?? "", { ...ALL, USD: "1.096" })));
    const src = createRateSource({ fetch, now: () => now });
    await src.get("USD");
    await src.get("EUR");
    now += 29_000;
    await src.get("USD");
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 2_000;
    await src.get("USD");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("falls back to ExchangeRate-API, dated by its own last update so old data looks old", async () => {
    const fetch = vi.fn<FetchLike>(async (url: string) => (url.includes("coinbase") ? json({}, 429) : json(erBody)));
    const t = await createRateSource({ fetch, now: () => NOW }).get("USD");
    expect(t.source).toBe("exchangerate-api");
    expect(t.asOf).toBe(new Date(1791331352 * 1000).toISOString());
    expect(t.rates.JPY).toBe(148.2312);
    expect(fetch.mock.calls[1][0]).toBe("https://open.er-api.com/v6/latest/USD");
  });

  it("never invents a rate: with no real table yet, failing sources mean RateUnavailableError", async () => {
    const onError = vi.fn();
    const fetch = vi.fn<FetchLike>(async () => json({ error: "down" }, 503));
    await expect(createRateSource({ fetch, now: () => NOW, onError }).get("USD")).rejects.toBeInstanceOf(RateUnavailableError);
    expect(onError).toHaveBeenCalledTimes(2); // Coinbase, then ExchangeRate-API
  });

  it("serves the last real table with its real asOf when every source fails later", async () => {
    let now = NOW;
    let fail = false;
    const fetch = vi.fn<FetchLike>(async () => (fail ? json({}, 500) : json(coinbaseBody())));
    const src = createRateSource({ fetch, now: () => now });
    const good = await src.get("USD");
    fail = true;
    now += 10 * 60_000;
    expect(await src.get("USD")).toEqual(good);
  });

  it("treats a missing currency, a wrong base, a bad number, a failed result and a thrown fetch as failures", async () => {
    const { KRW: _drop, ...noKrw } = ALL;
    for (const body of [coinbaseBody("USD", noKrw), coinbaseBody("EUR"), coinbaseBody("USD", { ...ALL, JPY: "x" }), coinbaseBody("USD", { ...ALL, GBP: "0" })]) {
      const fetch = vi.fn<FetchLike>(async (url: string) => (url.includes("coinbase") ? json(body) : json({ result: "error" })));
      await expect(createRateSource({ fetch, now: () => NOW }).get("USD")).rejects.toBeInstanceOf(RateUnavailableError);
    }
    const throwing = vi.fn<FetchLike>(async () => { throw new Error("timeout"); });
    await expect(createRateSource({ fetch: throwing, now: () => NOW }).get("EUR")).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it("backs off for the cache window after a failure instead of hammering the sources", async () => {
    let now = NOW;
    const fetch = vi.fn<FetchLike>(async () => json({}, 429));
    const src = createRateSource({ fetch, now: () => now });
    await src.get("USD").catch(() => undefined);
    const afterFirst = fetch.mock.calls.length;
    now += 5_000;
    await src.get("USD").catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(afterFirst);
  });

  it("knows its currencies and rounds rates to six significant digits", () => {
    expect(isSupportedCurrency("SGD")).toBe(true);
    expect(isSupportedCurrency("BTC")).toBe(false);
    expect(roundRate(148.23123)).toBe(148.231);
    expect(roundRate(0.000724375226)).toBe(0.000724375);
  });
});
