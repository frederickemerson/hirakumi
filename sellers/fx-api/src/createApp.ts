import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { isSupportedCurrency, RateUnavailableError, roundRate, SUPPORTED_CURRENCIES, type Currency, type RateSource } from "./rateSource.js";
import { isBreakMode, BREAK_MODES, type BreakMode, type ModeStore, ReadOnlyModeError } from "./modeStore.js";
import { buildOpenApi, DEFAULT_TITLE } from "./openapi.js";
import { latestCode } from "./challenge.js";

/** How old "stale" mode makes every asOf: hours, well past any freshness promise. */
export const STALE_AGE_MS = 2 * 3_600_000;
const MAX_AMOUNT = 1e12;

export type AppDeps = {
  rates: RateSource;
  modes: ModeStore;
  now: () => number;
  adminToken: string | undefined;
  /** API_KEY: when set, /rate and /convert answer only calls that send it in X-API-Key (the seller's own key). */
  apiKey?: string;
  /** Hirakumi ownership codes by API id; the latest one set is sent as the X-Hirakumi-Verify header (see challenge.ts). */
  verifyCodes: Record<string, string>;
  publicUrl: string;
  /** The OpenAPI info.title, which becomes the listing's name on Hirakumi (API_TITLE). */
  title?: string;
  log: (msg: string, err?: unknown) => void;
};

function sameSecret(expected: string, given: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

const currencyParam = (req: Request, name: string) => (typeof req.query[name] === "string" ? (req.query[name] as string).trim().toUpperCase() : "");

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
      res.status(503).json({ error: "admin_disabled", message: "Set ADMIN_TOKEN to enable the break switch" });
      return;
    }
    const header = req.get("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!sameSecret(deps.adminToken, given)) {
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

  /** The pair from the query, or null after answering 400. */
  function pair(req: Request, res: Response): { from: Currency; to: Currency } | null {
    const from = currencyParam(req, "from");
    const to = currencyParam(req, "to");
    if (!isSupportedCurrency(from) || !isSupportedCurrency(to)) {
      res.status(400).json({ error: "unknown_currency", message: `from and to must each be one of ${SUPPORTED_CURRENCIES.join(", ")}` });
      return null;
    }
    return { from, to };
  }

  /**
   * The rate for the pair under the current break mode: null after answering (empty mode or no real rate),
   * else the rate and its asOf.
   */
  async function quote(res: Response, from: Currency, to: Currency): Promise<{ rate: number; asOf: string } | null> {
    const mode: BreakMode = await deps.modes.get().catch((err: unknown) => {
      deps.log("mode store read failed; serving normal data", err);
      return "ok" as const;
    });
    res.set("Cache-Control", "no-store");
    if (mode === "empty") {
      res.json({});
      return null;
    }
    let table;
    try {
      table = await deps.rates.get(from);
    } catch (err) {
      if (!(err instanceof RateUnavailableError)) throw err;
      res.status(503).json({ error: "rate_unavailable", message: "The upstream rate feed is unavailable. Try again in a minute." });
      return null;
    }
    res.set("X-Rate-Source", table.source);
    const asOf = mode === "stale" ? new Date(deps.now() - STALE_AGE_MS).toISOString() : table.asOf;
    return { rate: roundRate(table.rates[to]), asOf };
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, modeStore: deps.modes.kind });
  });

  app.get("/openapi.json", (_req, res) => {
    // no-store: a cache must not keep an answer with an old X-Hirakumi-Verify code.
    res.set("Cache-Control", "no-store").json(buildOpenApi(deps.publicUrl, deps.title ?? DEFAULT_TITLE, Boolean(deps.apiKey)));
  });

  app.get("/rate", requireKey, async (req, res) => {
    const p = pair(req, res);
    if (!p) return;
    const q = await quote(res, p.from, p.to);
    if (!q) return;
    res.json({ from: p.from, to: p.to, rate: q.rate, asOf: q.asOf });
  });

  app.get("/convert", requireKey, async (req, res) => {
    const p = pair(req, res);
    if (!p) return;
    const raw = typeof req.query.amount === "string" ? req.query.amount.trim() : "";
    const amount = raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      res.status(400).json({ error: "invalid_amount", message: `amount must be a number above 0 and at most ${MAX_AMOUNT}` });
      return;
    }
    const q = await quote(res, p.from, p.to);
    if (!q) return;
    const result = Math.round(amount * q.rate * 10_000) / 10_000;
    res.json({ from: p.from, to: p.to, amount, result, rate: q.rate, asOf: q.asOf });
  });

  app.post("/admin/break", requireAdmin, express.json({ limit: "1kb" }), async (req, res) => {
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (!isBreakMode(mode)) {
      res.status(400).json({ error: "invalid_mode", message: `mode must be one of ${BREAK_MODES.join(", ")}` });
      return;
    }
    try {
      await deps.modes.set(mode);
    } catch (e) {
      if (e instanceof ReadOnlyModeError) { res.status(409).json({ error: "mode_read_only", message: e.message }); return; }
      throw e;
    }
    deps.log(`break mode set to ${mode}`);
    res.json({ mode });
  });

  // Demo stand-in for "send the X-Hirakumi-Verify header": the demo operator sets the API's code (shown on
  // Hirakumi's ownership page) without a redeploy. The latest code set is the one every answer sends.
  // Kept in memory; restarts fall back to HIRAKUMI_CHALLENGE.
  app.put("/admin/challenge/:apiId", requireAdmin, express.text({ limit: "1kb", type: "*/*" }), (req, res) => {
    const apiId = String(req.params.apiId);
    const code = typeof req.body === "string" ? req.body.trim() : "";
    if (!/^api_[A-Za-z0-9]+$/.test(apiId) || !code) {
      res.status(400).json({ error: "bad_request", message: "PUT /admin/challenge/api_xxx with the verification code (hkv_...) as text/plain" });
      return;
    }
    delete deps.verifyCodes[apiId]; // re-insert so this code becomes the latest
    deps.verifyCodes[apiId] = code;
    res.status(204).end();
  });

  app.get("/admin/break", requireAdmin, async (_req, res) => {
    res.json({ mode: await deps.modes.get(), store: deps.modes.kind });
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
