import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Monitor } from "../src/monitor";
import { makeHarness, type Harness } from "./helpers";

let h: Harness; let m: Monitor;
beforeEach(async () => {
  h = await makeHarness();
  m = new Monitor({ sql: h.sql, registry: h.registry, health: h.health, config: h.config });
});
afterEach(async () => { m.stop(); await h.close(); });

const events = () => h.sql<{ from_health: string; to_health: string; reasons: Array<{ op: string; reason: string; since: string | null }> }[]>`
  select from_health, to_health, reasons from health_events order by id`;

describe("Monitor (demo thresholds: 2 fails → Down, 2 passes → Live)", () => {
  it("stays Live while probes pass and logs probe calls with the probe header", async () => {
    expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    expect(h.health.get(h.seeded.apiId)?.health).toBe("healthy");
    expect(h.stub.lastHeaders()?.["x-hirakumi-probe"]).toBe("1");
    const [c] = await h.sql<{ kind: string; verdict: string }[]>`select kind, verdict from calls`;
    expect(c).toEqual({ kind: "probe", verdict: "pass" });
    const [api] = await h.sql<{ health_checked_at: Date | null }[]>`select health_checked_at from apis`;
    expect(api.health_checked_at).not.toBeNull();
  });

  it("flips to Down on the 2nd failure: DB, health_events, /availability 503, proxy 503, pack 503", async () => {
    h.stub.setMode("empty");
    expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    const t = await m.probeApi(h.seeded.apiId);
    expect(t).toMatchObject({ from: "healthy", to: "down" });
    const [api] = await h.sql<{ health: string }[]>`select health from apis`;
    expect(api.health).toBe("down");
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ from_health: "healthy", to_health: "down" });
    expect(ev[0].reasons).toEqual(expect.arrayContaining([expect.objectContaining({ op: "getPrice", reason: "/price is missing" })]));
    expect(ev[0].reasons[0].since).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const av = await request(h.app).get(`/a/${h.seeded.apiId}/availability`);
    expect(av.status).toBe(503);
    expect(av.body).toMatchObject({ status: "unavailable", estimated_downtime_seconds: 20 });
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`)).status).toBe(503);
    expect((await request(h.app).post(`/a/${h.seeded.apiId}/packs/${h.seeded.packId}`)).status).toBe(503);
  });

  it("comes back Live after 2 passes and writes a second event", async () => {
    h.stub.setMode("empty");
    await m.probeApi(h.seeded.apiId);
    await m.probeApi(h.seeded.apiId);
    h.stub.setMode("ok");
    expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    expect(await m.probeApi(h.seeded.apiId)).toMatchObject({ from: "down", to: "healthy" });
    expect((await events()).map((e) => e.to_health)).toEqual(["down", "healthy"]);
    const av = await request(h.app).get(`/a/${h.seeded.apiId}/availability`);
    expect(av.status).toBe(200);
    expect(av.body).toMatchObject({ status: "available", type: "masumi-agent" });
  });

  it("tick() probes every live/registering API and skips others", async () => {
    await h.sql`update apis set state = 'priced'`;
    h.registry.invalidate(h.seeded.apiId);
    await m.tick();
    expect(h.stub.hits()).toBe(0);
    await h.sql`update apis set state = 'registering'`;
    h.registry.invalidate(h.seeded.apiId);
    await m.tick();
    expect(h.stub.hits()).toBe(1);
  });

  it("/availability answers 200 during registration (the registry checks it then) and 404 for unknown", async () => {
    await h.sql`update apis set state = 'registering'`;
    h.registry.invalidate(h.seeded.apiId);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/availability`)).status).toBe(200);
    expect((await request(h.app).get(`/a/api_nope/availability`)).status).toBe(404);
  });
});
