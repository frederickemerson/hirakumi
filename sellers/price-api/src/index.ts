import { createApp } from "./createApp.js";
import { createPriceSource } from "./priceSource.js";
import { modeStoreFromEnv } from "./modeStore.js";
import { parseChallenges } from "./challenge.js";

const log = (msg: string, err?: unknown) => console.error(`[price-api] ${msg}`, err ?? "");
const publicUrl =
  process.env.PUBLIC_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${process.env.PORT ?? 4100}`);

const app = createApp({
  prices: createPriceSource({
    fetch,
    now: Date.now,
    coingeckoApiKey: process.env.COINGECKO_API_KEY,
    onError: (e) => log("price source failed (trying the next real source, else the last real quote)", e),
  }),
  modes: modeStoreFromEnv(process.env),
  now: Date.now,
  adminToken: process.env.ADMIN_TOKEN,
  verifyCodes: parseChallenges(process.env.HIRAKUMI_CHALLENGE, log),
  publicUrl,
  log,
});

export default app;
