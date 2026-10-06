import { createApp, type AppDeps } from "../src/createApp.js";
import { memoryModeStore, type ModeStore } from "../src/modeStore.js";
import type { PriceSource, Quote } from "../src/priceSource.js";

export const NOW = Date.UTC(2026, 9, 6, 8, 0, 0);
export const ADMIN = "admin-token-0123456789abcdef";
export const fixedPrices: PriceSource = {
  async get(symbol): Promise<Quote> {
    return { symbol, usd: 0.2695, change24h: 1.25, timestamp: new Date(NOW - 60_000).toISOString(), source: "coingecko" };
  },
};
export function makeApp(over: Partial<AppDeps> & { modes?: ModeStore } = {}) {
  return createApp({
    prices: fixedPrices,
    modes: memoryModeStore(),
    now: () => NOW,
    adminToken: ADMIN,
    verifyCodes: {},
    publicUrl: "https://price.test",
    log: () => {},
    ...over,
  });
}
