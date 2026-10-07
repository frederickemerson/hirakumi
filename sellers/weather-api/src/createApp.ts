import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { latestCode } from "./challenge.js";
import { buildOpenApi, DEFAULT_TITLE } from "./openapi.js";
import { CITIES, CITY_IDS, isCityId, MAX_FORECAST_DAYS, WeatherUnavailableError, type CityId, type Reading, type WeatherSource } from "./weather.js";

export type AppDeps = {
  weather: WeatherSource;
  adminToken: string | undefined;
  /** API_KEY: when set, /current and /forecast answer only calls that send it in X-API-Key (the seller's own key). */
  apiKey?: string;
  /** Hirakumi ownership codes by API id; the latest one set is sent as the X-Hirakumi-Verify header. */
  verifyCodes: Record<string, string>;
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

  // Hirakumi's ownership proof: every answer, a 404 or an error included, carries the latest code set.
  app.use((_req, res, next) => {
    const code = latestCode(deps.verifyCodes);
    if (code) res.set("X-Hirakumi-Verify", code);
    next();
  });

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!deps.adminToken) {
      res.status(503).json({ error: "admin_disabled", message: "Set ADMIN_TOKEN to enable admin routes" });
      return;
    }
    const header = req.get("authorization") ?? "";
    if (!sameSecret(deps.adminToken, header.startsWith("Bearer ") ? header.slice(7) : "")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

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
      return { city, r: await deps.weather.get(city) };
    } catch (err) {
      if (!(err instanceof WeatherUnavailableError)) throw err;
      deps.log(`weather unavailable for ${city}`, err);
      res.status(503).json({ error: "weather_unavailable", message: "The upstream weather feed is unavailable. Try again in a minute." });
      return null;
    }
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/openapi.json", (_req, res) => {
    res.set("Cache-Control", "no-store").json(buildOpenApi(deps.publicUrl, deps.title ?? DEFAULT_TITLE, Boolean(deps.apiKey)));
  });

  app.get("/current", requireKey, async (req, res) => {
    const got = await reading(req, res);
    if (!got) return;
    res.json({ city: CITIES[got.city].name, ...got.r.current, asOf: got.r.asOf });
  });

  app.get("/forecast", requireKey, async (req, res) => {
    const raw = typeof req.query.days === "string" ? req.query.days.trim() : "3";
    const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > MAX_FORECAST_DAYS) {
      res.status(400).json({ error: "invalid_days", message: `days must be an integer from 1 to ${MAX_FORECAST_DAYS}` });
      return;
    }
    const got = await reading(req, res);
    if (!got) return;
    res.json({ city: CITIES[got.city].name, days: got.r.daily.slice(0, days), asOf: got.r.asOf });
  });

  // The demo operator sets the API's code (shown on Hirakumi's ownership page) without a redeploy.
  // Kept in memory; restarts fall back to HIRAKUMI_CHALLENGE.
  app.put("/admin/challenge/:apiId", requireAdmin, express.text({ limit: "1kb", type: "*/*" }), (req, res) => {
    const apiId = String(req.params.apiId);
    const code = typeof req.body === "string" ? req.body.trim() : "";
    if (!/^api_[A-Za-z0-9]+$/.test(apiId) || !code) {
      res.status(400).json({ error: "bad_request", message: "PUT /admin/challenge/api_xxx with the verification code (hkv_...) as text/plain" });
      return;
    }
    delete deps.verifyCodes[apiId];
    deps.verifyCodes[apiId] = code;
    res.status(204).end();
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
