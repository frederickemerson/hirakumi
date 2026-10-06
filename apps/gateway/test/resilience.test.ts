import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Sql } from "@hirakumi/db";
import { JobRunner } from "../src/jobs";
import { Monitor } from "../src/monitor";
import { makeHarness, type Harness } from "./helpers";

// Review I2: a transient database error (Neon reconnect, scale-to-zero) inside a background loop must be
// logged, never thrown, or Node exits on the unhandled rejection and the monitor's counters are lost.
const brokenSql = (() => { throw new Error("connection terminated unexpectedly"); }) as unknown as Sql;

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { vi.restoreAllMocks(); await h.close(); });

describe("background loops survive database errors", () => {
  it("Monitor.tick resolves and logs when listing APIs fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const m = new Monitor({ sql: brokenSql, registry: h.registry, health: h.health, config: h.config });
    await expect(m.tick()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
  it("JobRunner.tick resolves and logs when listing jobs fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = new JobRunner({ sql: brokenSql, registry: h.registry, masumi: h.masumi, config: h.config });
    await expect(r.tick()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});

describe("malformed credit tokens (stress finding)", () => {
  it("a Bearer value that isn't an hk_ token gets 401 invalid_token, not a pack offer", async () => {
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", "Bearer not-a-token");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid_token");
  });
  it("no Authorization header still gets the 402 pack offer", async () => {
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`);
    expect(r.status).toBe(402);
  });
});
