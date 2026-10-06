import express, { type Express } from "express";
import { getRuleByHash } from "@hirakumi/db";
import { creditsRouter } from "./credits";
import type { AppDeps } from "./deps";
import { errorHandler } from "./http";

export function createApp(d: AppDeps): Express {
  const app = express();
  app.set("trust proxy", true); // Caddy terminates TLS; x402 resource URLs must say https
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  app.use(creditsRouter(d));
  app.get("/r/:ruleHash", async (req, res, next) => {
    try {
      const rule = await getRuleByHash(d.sql, req.params.ruleHash);
      if (!rule) { res.status(404).json({ error: "rule_not_found" }); return; }
      res.set("cache-control", "public, max-age=31536000, immutable").json({
        ruleHash: rule.hash, version: rule.version, definition: rule.definition,
        plain_english: rule.plain_english, created_at: rule.created_at,
      });
    } catch (e) { next(e); }
  });
  app.use(errorHandler);
  return app;
}
