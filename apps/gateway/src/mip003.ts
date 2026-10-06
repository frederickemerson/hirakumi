import { Router } from "express";
import { estimatedDowntimeSeconds } from "./config";
import type { AppDeps } from "./deps";

export function mip003Router(d: AppDeps): Router {
  const r = Router();

  r.get("/a/:apiId/availability", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded || !(loaded.api.state === "live" || loaded.api.state === "registering")) {
        res.status(404).json({ status: "unavailable", message: "Unknown API." });
        return;
      }
      const snap = d.health.get(loaded.api.id);
      if (snap?.health === "down") {
        const first = snap.lastReasons[0];
        res.status(503).json({
          status: "unavailable",
          message: `${loaded.api.name} is Down${first ? `: ${first.op} ${first.reason}` : ""}.`,
          estimated_downtime_seconds: estimatedDowntimeSeconds(d.config),
        });
        return;
      }
      res.json({ status: "available", type: "masumi-agent", message: `${loaded.api.name} is Live. Every answer is checked against a published promise.` });
    } catch (e) { next(e); }
  });

  return r;
}
