import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeApp, ADMIN, NOW } from "./helpers.js";
import { memoryModeStore, type ModeStore } from "../src/modeStore.js";

describe("GET /price", () => {
  it("returns exactly symbol, usd, change24h, timestamp", async () => {
    const res = await request(makeApp()).get("/price?symbol=ADA");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ symbol: "ADA", usd: 0.2695, change24h: 1.25, timestamp: new Date(NOW - 60_000).toISOString() });
    expect(res.headers["x-price-source"]).toBe("coingecko");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("accepts lowercase symbols", async () => {
    expect((await request(makeApp()).get("/price?symbol=ada")).body.symbol).toBe("ADA");
  });

  it("rejects unknown or missing symbols with 400", async () => {
    const app = makeApp();
    expect((await request(app).get("/price?symbol=DOGE")).status).toBe(400);
    const res = await request(app).get("/price");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_symbol");
  });

  it("empty mode returns {}", async () => {
    const res = await request(makeApp({ modes: memoryModeStore("empty") })).get("/price?symbol=ADA");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("stale mode returns a timestamp exactly one hour old", async () => {
    const res = await request(makeApp({ modes: memoryModeStore("stale") })).get("/price?symbol=ADA");
    expect(res.body.timestamp).toBe(new Date(NOW - 3_600_000).toISOString());
    expect(res.body.usd).toBe(0.2695);
  });

  it("serves normal data if the mode store is unreachable", async () => {
    const broken: ModeStore = { kind: "redis", get: async () => { throw new Error("redis down"); }, set: async () => {} };
    const res = await request(makeApp({ modes: broken })).get("/price?symbol=ADA");
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe("ADA");
  });

  it("break then fix round-trip through the admin switch", async () => {
    const app = makeApp();
    const auth = { Authorization: `Bearer ${ADMIN}` };
    await request(app).post("/admin/break").set(auth).send({ mode: "empty" }).expect(200);
    expect((await request(app).get("/price?symbol=ADA")).body).toEqual({});
    await request(app).post("/admin/break").set(auth).send({ mode: "ok" }).expect(200);
    expect((await request(app).get("/price?symbol=ADA")).body.symbol).toBe("ADA");
  });
});
