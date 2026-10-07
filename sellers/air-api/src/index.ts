import { createApp } from "./createApp.js";
import { openMeteoSource } from "./air.js";

const log = (msg: string, err?: unknown) => console.log(`[air-api] ${msg}`, err instanceof Error ? err.message : err ?? "");
const publicUrl =
  process.env.PUBLIC_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${process.env.PORT ?? 4100}`);

const app = createApp({
  air: openMeteoSource(fetch),
  apiKey: process.env.API_KEY || undefined,
  publicUrl,
  title: process.env.API_TITLE || undefined,
  log,
});

export default app;
