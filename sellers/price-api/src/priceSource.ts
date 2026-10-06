export const SUPPORTED_SYMBOLS = ["ADA", "BTC", "ETH", "SOL"] as const;
export type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];
export type Quote = { symbol: SupportedSymbol; usd: number; change24h: number; timestamp: string; source: "coingecko" | "fallback" };
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type PriceSource = { get(symbol: SupportedSymbol): Promise<Quote> };

const COINGECKO_IDS: Record<SupportedSymbol, string> = { ADA: "cardano", BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };
// Deterministic fallback so the demo never depends on a third-party rate limit.
const FALLBACK_USD: Record<SupportedSymbol, number> = { ADA: 0.5, BTC: 60000, ETH: 3000, SOL: 150 };

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
  const cache = new Map<SupportedSymbol, { fetchedAt: number; quote: Quote }>();

  async function live(symbol: SupportedSymbol): Promise<Quote> {
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

  function fallback(symbol: SupportedSymbol): Quote {
    return { symbol, usd: FALLBACK_USD[symbol], change24h: 0, timestamp: new Date(opts.now()).toISOString(), source: "fallback" };
  }

  return {
    async get(symbol) {
      const now = opts.now();
      const hit = cache.get(symbol);
      if (hit && now - hit.fetchedAt < ttlMs) return hit.quote;
      let quote: Quote;
      try {
        quote = await live(symbol);
      } catch (err) {
        opts.onError?.(err);
        quote = fallback(symbol);
      }
      cache.set(symbol, { fetchedAt: now, quote });
      return quote;
    },
  };
}
