import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { isSupportedSymbol, SUPPORTED_SYMBOLS, type PriceSource } from "./priceSource.js";
import { isBreakMode, BREAK_MODES, type BreakMode, type ModeStore } from "./modeStore.js";
import { buildOpenApi } from "./openapi.js";

export const STALE_AGE_MS = 3_600_000;

export type AppDeps = {
  prices: PriceSource;
  modes: ModeStore;
  now: () => number;
  adminToken: string | undefined;
  challenges: Record<string, string>;
  publicUrl: string;
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

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, modeStore: deps.modes.kind });
  });

  app.get("/openapi.json", (_req, res) => {
    res.json(buildOpenApi(deps.publicUrl));
  });

  app.get("/price", async (req, res) => {
    const raw = typeof req.query.symbol === "string" ? req.query.symbol.trim().toUpperCase() : "";
    if (!isSupportedSymbol(raw)) {
      res.status(400).json({ error: "unknown_symbol", message: `symbol must be one of ${SUPPORTED_SYMBOLS.join(", ")}` });
      return;
    }
    const mode: BreakMode = await deps.modes.get().catch((err: unknown) => {
      deps.log("mode store read failed; serving normal data", err);
      return "ok" as const;
    });
    res.set("Cache-Control", "no-store");
    if (mode === "empty") {
      res.json({});
      return;
    }
    const quote = await deps.prices.get(raw);
    res.set("X-Price-Source", quote.source);
    const timestamp = mode === "stale" ? new Date(deps.now() - STALE_AGE_MS).toISOString() : quote.timestamp;
    res.json({ symbol: quote.symbol, usd: quote.usd, change24h: quote.change24h, timestamp });
  });

  app.post("/admin/break", requireAdmin, express.json({ limit: "1kb" }), async (req, res) => {
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (!isBreakMode(mode)) {
      res.status(400).json({ error: "invalid_mode", message: `mode must be one of ${BREAK_MODES.join(", ")}` });
      return;
    }
    await deps.modes.set(mode);
    deps.log(`break mode set to ${mode}`);
    res.json({ mode });
  });

  app.get("/admin/break", requireAdmin, async (_req, res) => {
    res.json({ mode: await deps.modes.get(), store: deps.modes.kind });
  });

  app.get("/.well-known/hirakumi/:file", (req, res) => {
    const m = /^(api_[A-Za-z0-9]+)\.txt$/.exec(req.params.file);
    const apiId = m?.[1];
    if (!apiId || !Object.hasOwn(deps.challenges, apiId)) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    res.set("Cache-Control", "no-store").type("text/plain; charset=utf-8").send(deps.challenges[apiId]);
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
