import { createApp, type AppDeps } from "../src/createApp.js";
import { memoryModeStore, type ModeStore } from "../src/modeStore.js";
import { SUPPORTED_CURRENCIES, type Currency, type RateSource, type RateTable } from "../src/rateSource.js";

export const NOW = Date.UTC(2026, 9, 7, 8, 0, 0);
export const ADMIN = "admin-token-0123456789abcdef";
/** Units per one USD. */
export const USD: Record<Currency, number> = {
  USD: 1, EUR: 0.912345678, GBP: 0.78, JPY: 148.2312, SGD: 1.34, CHF: 0.88, AUD: 1.52, CAD: 1.37, INR: 83.4, CNY: 7.24, HKD: 7.81, KRW: 1380.5,
};
export const fixedRates: RateSource = {
  async get(base): Promise<RateTable> {
    const rates = Object.fromEntries(SUPPORTED_CURRENCIES.map((c) => [c, USD[c] / USD[base]])) as Record<Currency, number>;
    return { base, rates, asOf: new Date(NOW - 20_000).toISOString(), source: "coinbase" };
  },
};
export function makeApp(over: Partial<AppDeps> & { modes?: ModeStore } = {}) {
  return createApp({
    rates: fixedRates,
    modes: memoryModeStore(),
    now: () => NOW,
    adminToken: ADMIN,
    verifyCodes: {},
    publicUrl: "https://mika.test",
    log: () => {},
    ...over,
  });
}
