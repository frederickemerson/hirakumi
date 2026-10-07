import { createApp } from "./createApp.js";
import { createRateSource } from "./rateSource.js";
import { modeStoreFromEnv } from "./modeStore.js";
import { parseChallenges } from "./challenge.js";

const log = (msg: string, err?: unknown) => console.error(`[fx-api] ${msg}`, err ?? "");
const publicUrl =
  process.env.PUBLIC_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${process.env.PORT ?? 4100}`);

const app = createApp({
  rates: createRateSource({
    fetch,
    now: Date.now,
    onError: (e) => log("rate source failed (trying the next real source, else the last real table)", e),
  }),
  modes: modeStoreFromEnv(process.env),
  now: Date.now,
  adminToken: process.env.ADMIN_TOKEN,
  apiKey: process.env.API_KEY || undefined,
  verifyCodes: parseChallenges(process.env.HIRAKUMI_CHALLENGE, log),
  publicUrl,
  title: process.env.API_TITLE || undefined,
  log,
});

export default app;
