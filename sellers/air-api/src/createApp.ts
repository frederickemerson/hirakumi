import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { buildOpenApi, DEFAULT_TITLE } from "./openapi.js";
import {
  AirUnavailableError, CITIES, CITY_IDS, DEFAULT_FORECAST_HOURS, isCityId, MAX_FORECAST_HOURS,
  type AirSource, type CityId, type Reading,
} from "./air.js";

export type AppDeps = {
  air: AirSource;
  /** API_KEY: when set, /now and /forecast answer only calls that send it in X-API-Key (the seller's own key). */
  apiKey?: string;
  publicUrl: string;
  title?: string;
  log: (msg: string, err?: unknown) => void;
};

function sameSecret(expected: string, given: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  // A paid API refuses strangers: with API_KEY set, the data routes need it (Hirakumi's gateway sends it).
  const requireKey = (req: Request, res: Response, next: NextFunction) => {
    if (deps.apiKey && !sameSecret(deps.apiKey, req.get("x-api-key") ?? "")) {
      res.status(401).json({ error: "api_key_required", message: "Send your API key in the X-API-Key header" });
      return;
    }
    next();
  };

  /** The city and its reading, or null after answering. */
  async function reading(req: Request, res: Response): Promise<{ city: CityId; r: Reading } | null> {
    const city = typeof req.query.city === "string" ? req.query.city.trim().toLowerCase() : "";
    if (!isCityId(city)) {
      res.status(400).json({ error: "unknown_city", message: `city must be one of ${CITY_IDS.join(", ")}` });
      return null;
    }
    res.set("Cache-Control", "no-store");
    try {
      return { city, r: await deps.air.get(city) };
    } catch (err) {
      if (!(err instanceof AirUnavailableError)) throw err;
      deps.log(`air quality unavailable for ${city}`, err);
      res.status(503).json({ error: "air_unavailable", message: "The upstream air quality feed is unavailable. Try again in a minute." });
      return null;
    }
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/openapi.json", (_req, res) => {
    res.set("Cache-Control", "no-store").json(buildOpenApi(deps.publicUrl, deps.title ?? DEFAULT_TITLE, Boolean(deps.apiKey)));
  });

  app.get("/now", requireKey, async (req, res) => {
    const got = await reading(req, res);
    if (!got) return;
    res.json({ city: CITIES[got.city].name, ...got.r.current, asOf: got.r.asOf });
  });

  app.get("/forecast", requireKey, async (req, res) => {
    const raw = typeof req.query.hours === "string" ? req.query.hours.trim() : String(DEFAULT_FORECAST_HOURS);
    const hours = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_FORECAST_HOURS) {
      res.status(400).json({ error: "invalid_hours", message: `hours must be an integer from 1 to ${MAX_FORECAST_HOURS}` });
      return;
    }
    const got = await reading(req, res);
    if (!got) return;
    res.json({ city: CITIES[got.city].name, hours: got.r.hourly.slice(0, hours), asOf: got.r.asOf });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    deps.log("unhandled error", err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
