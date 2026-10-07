import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/createApp.js";
import { condition, openMeteoSource, parseOpenMeteo, WeatherUnavailableError, type Reading } from "../src/weather.js";

const OPEN_METEO = {
  current: { temperature_2m: 31.4, relative_humidity_2m: 62, wind_speed_10m: 11.2, weather_code: 2 },
  daily: {
    time: ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"],
    temperature_2m_max: [33, 32, 31, 30], temperature_2m_min: [26, 25, 25, 24],
    precipitation_sum: [0, 3.2, 12, 0], weather_code: [1, 61, 95, 3],
  },
};
const ASOF = "2026-10-07T06:30:00.000Z";
const reading: Reading = parseOpenMeteo(OPEN_METEO, ASOF);

function app(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    weather: { get: async () => reading }, adminToken: "admin-secret", verifyCodes: {},
    publicUrl: "https://weather.example", log: () => {}, ...over,
  });
}

describe("weather-api", () => {
  it("current weather for a city, with asOf", async () => {
    const res = await request(app()).get("/current?city=Singapore");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ city: "Singapore", temperatureC: 31.4, humidityPct: 62, windKph: 11.2, condition: "partly cloudy", asOf: ASOF });
  });

  it("forecast: default 3 days, days=1..7, plain conditions", async () => {
    const res = await request(app()).get("/forecast?city=tokyo");
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(3);
    expect(res.body.days[2]).toEqual({ date: "2026-10-09", maxC: 31, minC: 25, precipitationMm: 12, condition: "thunderstorm" });
    expect((await request(app()).get("/forecast?city=tokyo&days=1")).body.days).toHaveLength(1);
  });

  it("bad input: 400, never a made-up answer", async () => {
    expect((await request(app()).get("/current?city=atlantis")).status).toBe(400);
    expect((await request(app()).get("/current")).status).toBe(400);
    for (const d of ["0", "8", "2.5", "x", "-1"]) expect((await request(app()).get(`/forecast?city=tokyo&days=${d}`)).status).toBe(400);
  });

  it("upstream down: 503", async () => {
    const res = await request(app({ weather: { get: async () => { throw new WeatherUnavailableError("down"); } } })).get("/current?city=tokyo");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("weather_unavailable");
  });

  it("every answer carries the latest X-Hirakumi-Verify code, set by the admin route", async () => {
    const a = app();
    expect((await request(a).get("/nope")).headers["x-hirakumi-verify"]).toBeUndefined();
    expect((await request(a).put("/admin/challenge/api_abc").send("hkv_1")).status).toBe(401);
    expect((await request(a).put("/admin/challenge/api_abc").set("authorization", "Bearer admin-secret").type("text/plain").send("hkv_1")).status).toBe(204);
    expect((await request(a).get("/nope")).headers["x-hirakumi-verify"]).toBe("hkv_1");
    expect((await request(a).get("/current?city=tokyo")).headers["x-hirakumi-verify"]).toBe("hkv_1");
  });

  it("openapi lists both operations with this server", async () => {
    const res = await request(app()).get("/openapi.json");
    expect(res.body.servers).toEqual([{ url: "https://weather.example" }]);
    expect(Object.keys(res.body.paths)).toEqual(["/current", "/forecast"]);
  });
});

describe("Open-Meteo source", () => {
  it("parses, maps WMO codes, and refuses junk", () => {
    expect(condition(0)).toBe("clear");
    expect(condition(999)).toBe("unknown");
    expect(() => parseOpenMeteo({}, ASOF)).toThrow(WeatherUnavailableError);
    expect(() => parseOpenMeteo({ ...OPEN_METEO, current: { ...OPEN_METEO.current, temperature_2m: "hot" } }, ASOF)).toThrow(WeatherUnavailableError);
  });

  it("concurrent first requests share one fetch; caches 60 s; a failure is not cached", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => OPEN_METEO }));
    const src = openMeteoSource(fetchImpl, () => t);
    await Promise.all([src.get("tokyo"), src.get("tokyo"), src.get("tokyo")]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = 61_000;
    await src.get("tokyo");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const failing = openMeteoSource(vi.fn(async () => ({ ok: false, json: async () => ({}) })), () => 0);
    await expect(failing.get("tokyo")).rejects.toThrow(WeatherUnavailableError);
  });
});

describe("API_KEY", () => {
  const keyed = () => createApp({
    weather: { get: async () => ({ current: { temperatureC: 30, humidityPct: 70, windKph: 10, condition: "clear" }, daily: [], asOf: new Date().toISOString() }) } as never,
    adminToken: undefined, apiKey: "k_123456789", verifyCodes: {}, publicUrl: "https://weather.example", log: () => {},
  });

  it("refuses data calls without the key, answers with it, and the spec declares it", async () => {
    expect((await request(keyed()).get("/current?city=singapore")).status).toBe(401);
    expect((await request(keyed()).get("/forecast?city=singapore").set("x-api-key", "wrong")).status).toBe(401);
    expect((await request(keyed()).get("/current?city=singapore").set("x-api-key", "k_123456789")).status).toBe(200);
    expect((await request(keyed()).get("/healthz")).status).toBe(200);
    const spec = (await request(keyed()).get("/openapi.json")).body;
    expect(spec.security).toEqual([{ apiKey: [] }]);
    expect(spec.components.securitySchemes.apiKey).toEqual({ type: "apiKey", in: "header", name: "X-API-Key" });
  });
});
