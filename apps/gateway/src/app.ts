import express, { type Express } from "express";
import { limitUrl } from "./server";
import { getRuleByHash } from "@hirakumi/db";
import { channelsRouter } from "./channels";
import { creditsRouter } from "./credits";
import type { AppDeps } from "./deps";
import { errorHandler } from "./http";
import { internalRouter } from "./internal";
import { mip003Router } from "./mip003";
import { packRouter } from "./packs";

export function createApp(d: AppDeps): Express {
  const app = express();
  // Exactly one proxy (Caddy) in front: trust its X-Forwarded-* only. `true` would take the client-supplied
  // leftmost X-Forwarded-For as req.ip and make per-client limits spoofable.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(limitUrl);
  app.use(express.json({ limit: "256kb" }));
  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  app.use(internalRouter(d));
  app.use(packRouter(d));
  app.use(creditsRouter(d));
  app.use(channelsRouter(d));
  app.use(mip003Router(d));
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
