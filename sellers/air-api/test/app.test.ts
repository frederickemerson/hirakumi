import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/createApp.js";
import { AirUnavailableError, category, openMeteoSource, parseOpenMeteo, type Reading } from "../src/air.js";

// The real shape: hourly starts at midnight UTC, current is the present hour.
const HOURS = Array.from({ length: 72 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 7, i));
  return d.toISOString().slice(0, 16);
});
const OPEN_METEO = {
  current: { time: "2026-10-07T06:00", interval: 3600, us_aqi: 161, pm2_5: 37.6, pm10: 43.5, ozone: 62, nitrogen_dioxide: 42.2 },
  hourly: { time: HOURS, us_aqi: HOURS.map((_, i) => 100 + i), pm2_5: HOURS.map((_, i) => 10 + i / 2) },
};
const ASOF = "2026-10-07T06:30:00.000Z";
const reading: Reading = parseOpenMeteo(OPEN_METEO, ASOF);

function app(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ air: { get: async () => reading }, publicUrl: "https://air.example", log: () => {}, ...over });
}

describe("air-api", () => {
  it("current air quality for a city, with category and asOf", async () => {
    const res = await request(app()).get("/now?city=Singapore");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ city: "Singapore", usAqi: 161, category: "unhealthy", pm25: 37.6, pm10: 43.5, ozone: 62, no2: 42.2, asOf: ASOF });
  });

  it("forecast: default 12 hours from the current hour, hours=1..48", async () => {
    const res = await request(app()).get("/forecast?city=tokyo");
    expect(res.status).toBe(200);
    expect(res.body.city).toBe("Tokyo");
    expect(res.body.hours).toHaveLength(12);
    expect(res.body.hours[0]).toEqual({ time: "2026-10-07T06:00:00Z", usAqi: 106, pm25: 13 });
    expect((await request(app()).get("/forecast?city=tokyo&hours=1")).body.hours).toHaveLength(1);
    expect((await request(app()).get("/forecast?city=tokyo&hours=48")).body.hours).toHaveLength(48);
  });

  it("bad city: 400, never a made-up answer", async () => {
    expect((await request(app()).get("/now?city=atlantis")).status).toBe(400);
    expect((await request(app()).get("/now")).body.error).toBe("unknown_city");
    expect((await request(app()).get("/forecast?city=atlantis")).status).toBe(400);
  });

  it("bad hours: 400", async () => {
    for (const h of ["0", "49", "2.5", "x", "-1", ""]) {
      const res = await request(app()).get(`/forecast?city=tokyo&hours=${h}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_hours");
    }
  });

  it("upstream down: 503", async () => {
    const down = app({ air: { get: async () => { throw new AirUnavailableError("down"); } } });
    const res = await request(down).get("/now?city=tokyo");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("air_unavailable");
    expect((await request(down).get("/forecast?city=tokyo")).status).toBe(503);
  });

  it("no ownership header or admin routes: ownership is DNS", async () => {
    const res = await request(app()).get("/now?city=tokyo");
    expect(res.headers["x-hirakumi-verify"]).toBeUndefined();
    expect((await request(app()).put("/admin/challenge/api_abc").send("hkv_1")).status).toBe(404);
  });

  it("openapi lists both operations with this server and the Clean Air title", async () => {
    const res = await request(app()).get("/openapi.json");
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.info.title).toBe("Clean Air");
    expect(res.body.servers).toEqual([{ url: "https://air.example" }]);
    expect(Object.keys(res.body.paths)).toEqual(["/now", "/forecast"]);
    expect(res.body.security).toBeUndefined();
    expect((await request(app({ title: "Other" })).get("/openapi.json")).body.info.title).toBe("Other");
  });
});

describe("US EPA AQI categories", () => {
  it("maps every band edge", () => {
    const cases: [number, string][] = [
      [0, "good"], [50, "good"], [51, "moderate"], [100, "moderate"],
      [101, "unhealthy for sensitive groups"], [150, "unhealthy for sensitive groups"],
      [151, "unhealthy"], [200, "unhealthy"], [201, "very unhealthy"], [300, "very unhealthy"],
      [301, "hazardous"], [500, "hazardous"],
    ];
    for (const [aqi, want] of cases) expect(category(aqi)).toBe(want);
  });
});

describe("Open-Meteo source", () => {
  it("parses from the current hour and refuses junk", () => {
    expect(reading.hourly).toHaveLength(48);
    expect(reading.hourly[0].time).toBe("2026-10-07T06:00:00Z");
    expect(() => parseOpenMeteo({}, ASOF)).toThrow(AirUnavailableError);
    expect(() => parseOpenMeteo({ ...OPEN_METEO, current: { ...OPEN_METEO.current, us_aqi: null } }, ASOF)).toThrow(AirUnavailableError);
    const gap = { ...OPEN_METEO, hourly: { ...OPEN_METEO.hourly, pm2_5: OPEN_METEO.hourly.pm2_5.map((v, i) => (i === 10 ? null : v)) } };
    expect(() => parseOpenMeteo(gap, ASOF)).toThrow(AirUnavailableError);
  });

  it("concurrent first requests share one fetch; caches 60 s; a failure is not cached", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async (_url: string) => ({ ok: true, json: async () => OPEN_METEO }));
    const src = openMeteoSource(fetchImpl, () => t);
    await Promise.all([src.get("tokyo"), src.get("tokyo"), src.get("tokyo")]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain("air-quality-api.open-meteo.com/v1/air-quality?latitude=35.6762&longitude=139.6503");
    t = 61_000;
    await src.get("tokyo");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    let ok = false;
    const flaky = vi.fn(async () => ({ ok, json: async () => OPEN_METEO }));
    const src2 = openMeteoSource(flaky, () => 0);
    await expect(src2.get("tokyo")).rejects.toThrow(AirUnavailableError);
    ok = true;
    await expect(src2.get("tokyo")).resolves.toBeTruthy();
    expect(flaky).toHaveBeenCalledTimes(2);
    const thrown = openMeteoSource(vi.fn(async () => { throw new Error("network"); }), () => 0);
    await expect(thrown.get("tokyo")).rejects.toThrow(AirUnavailableError);
  });
});

describe("API_KEY", () => {
  const keyed = () => createApp({ air: { get: async () => reading }, apiKey: "k_123456789", publicUrl: "https://air.example", log: () => {} });

  it("refuses data calls without the key, answers with it, and the spec declares it", async () => {
    const no = await request(keyed()).get("/now?city=singapore");
    expect(no.status).toBe(401);
    expect(no.body.error).toBe("api_key_required");
    expect((await request(keyed()).get("/forecast?city=singapore").set("x-api-key", "wrong")).status).toBe(401);
    expect((await request(keyed()).get("/now?city=singapore").set("x-api-key", "k_123456789")).status).toBe(200);
    expect((await request(keyed()).get("/forecast?city=singapore").set("x-api-key", "k_123456789")).status).toBe(200);
    expect((await request(keyed()).get("/healthz")).status).toBe(200);
    const spec = (await request(keyed()).get("/openapi.json")).body;
    expect(spec.security).toEqual([{ apiKey: [] }]);
    expect(spec.components.securitySchemes.apiKey).toEqual({ type: "apiKey", in: "header", name: "X-API-Key" });
  });
});
