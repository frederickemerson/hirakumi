export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "SGD", "CHF", "AUD", "CAD", "INR", "CNY", "HKD", "KRW"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
/** Every supported currency per one unit of `base`, and when those rates were real. */
export type RateTable = { base: Currency; rates: Record<Currency, number>; asOf: string; source: "coinbase" | "exchangerate-api" };
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type RateSource = { get(base: Currency): Promise<RateTable> };

/** Every real source failed and there is no earlier real table. Never answered with an invented rate. */
export class RateUnavailableError extends Error {
  constructor(readonly base: Currency) {
    super(`No real ${base} exchange rate is available right now`);
    this.name = "RateUnavailableError";
  }
}

export function isSupportedCurrency(x: string): x is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(x);
}

/** Picks every supported currency out of a source's rate map; throws unless each is a positive number. */
function pick(raw: Record<string, unknown>, base: Currency, source: string): Record<Currency, number> {
  const out = {} as Record<Currency, number>;
  for (const c of SUPPORTED_CURRENCIES) {
    const v = c === base ? 1 : Number(raw[c]);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${source} has no usable ${base}->${c} rate`);
    out[c] = v;
  }
  return out;
}

export function createRateSource(opts: {
  fetch: FetchLike;
  now: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}): RateSource {
  const ttlMs = opts.ttlMs ?? 30_000;
  // Last real table per base currency, and when we last asked (success or failure) for rate limiting.
  const lastGood = new Map<Currency, RateTable>();
  const askedAt = new Map<Currency, number>();
  const getJson = async (url: string) => {
    const res = await opts.fetch(url, { headers: { accept: "application/json", "user-agent": "hirakumi-fx-api" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000) });
    if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };

  /** Coinbase's public exchange rates: live, but undated, so the rate is as of the moment we fetched it. */
  async function coinbase(base: Currency): Promise<RateTable> {
    const asked = opts.now();
    const body = await getJson(`https://api.coinbase.com/v2/exchange-rates?currency=${base}`);
    const data = body.data as { currency?: unknown; rates?: unknown } | undefined;
    if (data?.currency !== base || !data.rates || typeof data.rates !== "object") throw new Error(`Coinbase response for ${base} has no rates`);
    return { base, rates: pick(data.rates as Record<string, unknown>, base, "Coinbase"), asOf: new Date(asked).toISOString(), source: "coinbase" };
  }

  /** ExchangeRate-API's open endpoint: updated about once a day, dated by its own last update. */
  async function exchangerateApi(base: Currency): Promise<RateTable> {
    const body = await getJson(`https://open.er-api.com/v6/latest/${base}`);
    const updated = body.time_last_update_unix;
    if (body.result !== "success" || typeof updated !== "number" || !body.rates || typeof body.rates !== "object") {
      throw new Error(`ExchangeRate-API response for ${base} lacks rates or time_last_update_unix`);
    }
    return { base, rates: pick(body.rates as Record<string, unknown>, base, "ExchangeRate-API"), asOf: new Date(updated * 1000).toISOString(), source: "exchangerate-api" };
  }

  return {
    /**
     * A failure never produces an invented rate: the last real table is served with its real asOf (so a promise
     * about freshness can see it is old), or RateUnavailableError when there is none.
     */
    async get(base) {
      const now = opts.now();
      const asked = askedAt.get(base);
      if (asked === undefined || now - asked >= ttlMs) {
        askedAt.set(base, now);
        for (const source of [coinbase, exchangerateApi]) {
          try {
            lastGood.set(base, await source(base));
            break;
          } catch (err) {
            opts.onError?.(err);
          }
        }
      }
      const table = lastGood.get(base);
      if (!table) throw new RateUnavailableError(base);
      return table;
    },
  };
}

/** Six significant digits: enough for KRW per USD and for USD per KRW alike. */
export const roundRate = (x: number) => Number(x.toPrecision(6));
