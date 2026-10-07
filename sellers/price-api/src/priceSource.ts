export const SUPPORTED_SYMBOLS = ["ADA", "BTC", "ETH", "SOL"] as const;
export type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];
export type Quote = { symbol: SupportedSymbol; usd: number; change24h: number; timestamp: string; source: "coingecko" | "coinbase" };
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type PriceSource = { get(symbol: SupportedSymbol): Promise<Quote> };

const COINGECKO_IDS: Record<SupportedSymbol, string> = { ADA: "cardano", BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };

/** CoinGecko is unreachable and there is no earlier real quote. Never answered with an invented price. */
export class PriceUnavailableError extends Error {
  constructor(readonly symbol: SupportedSymbol) {
    super(`No real ${symbol} price is available right now`);
    this.name = "PriceUnavailableError";
  }
}

export function isSupportedSymbol(x: string): x is SupportedSymbol {
  return (SUPPORTED_SYMBOLS as readonly string[]).includes(x);
}

function coingeckoUrl(id: string): string {
  const u = new URL("https://api.coingecko.com/api/v3/simple/price");
  u.searchParams.set("ids", id);
  u.searchParams.set("vs_currencies", "usd");
  u.searchParams.set("include_24hr_change", "true");
  u.searchParams.set("include_last_updated_at", "true");
  return u.toString();
}

export function createPriceSource(opts: {
  fetch: FetchLike;
  now: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  coingeckoApiKey?: string;
  onError?: (err: unknown) => void;
}): PriceSource {
  const ttlMs = opts.ttlMs ?? 30_000;
  // Last real quote per symbol, and when we last asked CoinGecko (success or failure) for rate limiting.
  const lastGood = new Map<SupportedSymbol, Quote>();
  const askedAt = new Map<SupportedSymbol, number>();
  const refreshing = new Map<SupportedSymbol, Promise<void>>();

  /** Coinbase Exchange public ticker: last trade price and its trade time, 24h change from the stats open. */
  async function coinbase(symbol: SupportedSymbol): Promise<Quote> {
    const base = `https://api.exchange.coinbase.com/products/${symbol}-USD`;
    const get = async (path: string) => {
      const res = await opts.fetch(`${base}/${path}`, { headers: { accept: "application/json", "user-agent": "hirakumi-price-api" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000) });
      if (!res.ok) throw new Error(`Coinbase answered HTTP ${res.status} for ${path}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const [ticker, stats] = await Promise.all([get("ticker"), get("stats")]);
    const usd = Number(ticker.price);
    const open = Number(stats.open);
    const time = typeof ticker.time === "string" ? Date.parse(ticker.time) : NaN;
    if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(open) || open <= 0 || !Number.isFinite(time)) {
      throw new Error(`Coinbase response for ${symbol} lacks price, time or open`);
    }
    return { symbol, usd, change24h: Math.round(((usd - open) / open) * 10_000) / 100, timestamp: ticker.time as string, source: "coinbase" };
  }

  async function coingecko(symbol: SupportedSymbol): Promise<Quote> {
    const id = COINGECKO_IDS[symbol];
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.coingeckoApiKey) headers["x-cg-demo-api-key"] = opts.coingeckoApiKey;
    const res = await opts.fetch(coingeckoUrl(id), { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000) });
    if (!res.ok) throw new Error(`CoinGecko answered HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, Record<string, unknown> | undefined>;
    const row = body[id];
    const usd = row?.usd;
    const change = row?.usd_24h_change;
    const updated = row?.last_updated_at;
    if (typeof usd !== "number" || typeof change !== "number" || typeof updated !== "number") {
      throw new Error(`CoinGecko response for ${id} lacks usd, usd_24h_change or last_updated_at`);
    }
    return {
      symbol,
      usd,
      change24h: Math.round(change * 100) / 100,
      timestamp: new Date(updated * 1000).toISOString(),
      source: "coingecko",
    };
  }

  return {
    /**
     * A failure never produces an invented price: the last real quote is served with its real timestamp
     * (so a promise about freshness can see it is old), or PriceUnavailableError when there is none.
     */
    async get(symbol) {
      const now = opts.now();
      const asked = askedAt.get(symbol);
      if (asked === undefined || now - asked >= ttlMs) {
        askedAt.set(symbol, now);
        const run = (async () => {
          for (const source of [coingecko, coinbase]) {
            try {
              lastGood.set(symbol, await source(symbol));
              break;
            } catch (err) {
              opts.onError?.(err);
            }
          }
        })().finally(() => refreshing.delete(symbol));
        refreshing.set(symbol, run);
      }
      // A caller that arrives during a refresh waits for it, so a cold start doesn't answer 503 to all but one.
      await refreshing.get(symbol);
      const quote = lastGood.get(symbol);
      if (!quote) throw new PriceUnavailableError(symbol);
      return quote;
    },
  };
}
