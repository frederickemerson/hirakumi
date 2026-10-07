import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeApp, ADMIN, NOW } from "./helpers.js";
import { memoryModeStore, type ModeStore } from "../src/modeStore.js";
import { RateUnavailableError } from "../src/rateSource.js";

const AS_OF = new Date(NOW - 20_000).toISOString();

describe("GET /rate", () => {
  it("returns exactly from, to, rate (six significant digits) and asOf", async () => {
    const res = await request(makeApp()).get("/rate?from=USD&to=EUR");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ from: "USD", to: "EUR", rate: 0.912346, asOf: AS_OF });
    expect(res.headers["x-rate-source"]).toBe("coinbase");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("crosses through the base table, accepts lowercase, and a currency to itself is 1", async () => {
    expect((await request(makeApp()).get("/rate?from=eur&to=jpy")).body).toMatchObject({ from: "EUR", to: "JPY", rate: 162.473 });
    expect((await request(makeApp()).get("/rate?from=KRW&to=USD")).body.rate).toBe(0.000724375);
    expect((await request(makeApp()).get("/rate?from=SGD&to=SGD")).body.rate).toBe(1);
  });

  it("rejects unknown or missing currencies with 400", async () => {
    const app = makeApp();
    for (const q of ["from=USD&to=XYZ", "from=BTC&to=EUR", "to=EUR", "from=USD", ""]) {
      const res = await request(app).get(`/rate?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error).toBe("unknown_currency");
    }
  });

  it("answers 503 instead of a made-up rate when no real rate is available", async () => {
    const rates = { get: async () => { throw new RateUnavailableError("USD"); } };
    const res = await request(makeApp({ rates })).get("/rate?from=USD&to=EUR");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("rate_unavailable");
  });
});

describe("GET /convert", () => {
  it("converts at the rate, to 4 decimal places, with the rate and asOf", async () => {
    const res = await request(makeApp()).get("/convert?from=USD&to=JPY&amount=100");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ from: "USD", to: "JPY", amount: 100, result: 14823.1, rate: 148.231, asOf: AS_OF });
    expect((await request(makeApp()).get("/convert?from=GBP&to=EUR&amount=2500.5")).body.result).toBe(2924.7598);
  });

  it("rejects a missing, zero, negative, non-numeric or huge amount with 400", async () => {
    const app = makeApp();
    for (const a of ["", "0", "-5", "abc", "1e13", "Infinity", "NaN"]) {
      const res = await request(app).get(`/convert?from=USD&to=EUR&amount=${a}`);
      expect(res.status, a).toBe(400);
      expect(res.body.error).toBe("invalid_amount");
    }
    expect((await request(app).get("/convert?from=USD&to=EUR")).status).toBe(400);
    expect((await request(app).get("/convert?from=USD&to=EUR&amount=1e12")).status).toBe(200);
  });

  it("checks the currencies before the amount", async () => {
    expect((await request(makeApp()).get("/convert?from=USD&to=XYZ&amount=-1")).body.error).toBe("unknown_currency");
  });
});

describe("break modes", () => {
  it("empty mode returns {} on both endpoints", async () => {
    const app = makeApp({ modes: memoryModeStore("empty") });
    for (const path of ["/rate?from=USD&to=EUR", "/convert?from=USD&to=EUR&amount=10"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    }
  });

  it("stale mode keeps the real rate but dates it two hours back", async () => {
    const app = makeApp({ modes: memoryModeStore("stale") });
    const stale = new Date(NOW - 2 * 3_600_000).toISOString();
    expect((await request(app).get("/rate?from=USD&to=EUR")).body).toEqual({ from: "USD", to: "EUR", rate: 0.912346, asOf: stale });
    expect((await request(app).get("/convert?from=USD&to=EUR&amount=10")).body.asOf).toBe(stale);
  });

  it("serves normal data if the mode store is unreachable", async () => {
    const broken: ModeStore = { kind: "redis", get: async () => { throw new Error("redis down"); }, set: async () => {} };
    const res = await request(makeApp({ modes: broken })).get("/rate?from=USD&to=EUR");
    expect(res.status).toBe(200);
    expect(res.body.from).toBe("USD");
  });

  it("break then fix round-trip through the admin switch", async () => {
    const app = makeApp();
    const auth = { Authorization: `Bearer ${ADMIN}` };
    await request(app).post("/admin/break").set(auth).send({ mode: "empty" }).expect(200);
    expect((await request(app).get("/rate?from=USD&to=EUR")).body).toEqual({});
    await request(app).post("/admin/break").set(auth).send({ mode: "ok" }).expect(200);
    expect((await request(app).get("/rate?from=USD&to=EUR")).body.rate).toBe(0.912346);
  });
});
