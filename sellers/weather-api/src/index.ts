import { createApp } from "./createApp.js";
import { parseChallenges } from "./challenge.js";
import { openMeteoSource } from "./weather.js";

const log = (msg: string, err?: unknown) => console.log(`[weather-api] ${msg}`, err instanceof Error ? err.message : err ?? "");
const publicUrl =
  process.env.PUBLIC_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${process.env.PORT ?? 4100}`);

const app = createApp({
  weather: openMeteoSource(fetch),
  adminToken: process.env.ADMIN_TOKEN || undefined,
  apiKey: process.env.API_KEY || undefined,
  verifyCodes: parseChallenges(process.env.HIRAKUMI_CHALLENGE, log),
  publicUrl,
  title: process.env.API_TITLE || undefined,
  log,
});

export default app;
