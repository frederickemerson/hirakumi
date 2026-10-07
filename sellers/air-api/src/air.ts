// Air quality from Open-Meteo (free, no key). Cached per city; never an invented reading: no real data means a 503.

export const CITIES = {
  singapore: { name: "Singapore", latitude: 1.2897, longitude: 103.8501 },
  tokyo: { name: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
  "hong-kong": { name: "Hong Kong", latitude: 22.3193, longitude: 114.1694 },
  seoul: { name: "Seoul", latitude: 37.5665, longitude: 126.978 },
  sydney: { name: "Sydney", latitude: -33.8688, longitude: 151.2093 },
  dubai: { name: "Dubai", latitude: 25.2048, longitude: 55.2708 },
  london: { name: "London", latitude: 51.5072, longitude: -0.1276 },
  paris: { name: "Paris", latitude: 48.8566, longitude: 2.3522 },
  berlin: { name: "Berlin", latitude: 52.52, longitude: 13.405 },
  "new-york": { name: "New York", latitude: 40.7128, longitude: -74.006 },
  "san-francisco": { name: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  "sao-paulo": { name: "Sao Paulo", latitude: -23.5505, longitude: -46.6333 },
} as const;
export type CityId = keyof typeof CITIES;
export const CITY_IDS = Object.keys(CITIES) as CityId[];
export const isCityId = (v: string): v is CityId => Object.hasOwn(CITIES, v);

export const MAX_FORECAST_HOURS = 48;
export const DEFAULT_FORECAST_HOURS = 12;
export const CACHE_MS = 60_000;

/** US EPA AQI bands, by upper bound (inclusive). */
const BANDS: [number, string][] = [
  [50, "good"],
  [100, "moderate"],
  [150, "unhealthy for sensitive groups"],
  [200, "unhealthy"],
  [300, "very unhealthy"],
];
export function category(usAqi: number): string {
  return BANDS.find(([max]) => usAqi <= max)?.[1] ?? "hazardous";
}

export type Reading = {
  current: { usAqi: number; category: string; pm25: number; pm10: number; ozone: number; no2: number };
  /** Hourly forecast from the current hour onward. */
  hourly: { time: string; usAqi: number; pm25: number }[];
  /** When this service fetched the reading from Open-Meteo (ISO 8601, UTC). */
  asOf: string;
};

export class AirUnavailableError extends Error {}

export type AirSource = { get(city: CityId): Promise<Reading> };

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const num = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new AirUnavailableError("Open-Meteo sent a non-number");
  return v;
};

/** Open-Meteo's UTC local time ("2026-10-07T15:00", timezone=UTC) as ISO 8601 with Z. */
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Parses Open-Meteo's /v1/air-quality answer. The hourly series starts at midnight UTC, so only the hours from the
 * current reading's hour onward are kept, enough for MAX_FORECAST_HOURS. Throws AirUnavailableError on anything unexpected.
 */
export function parseOpenMeteo(body: unknown, asOf: string): Reading {
  const b = body as { current?: Record<string, unknown>; hourly?: Record<string, unknown[]> };
  const c = b?.current;
  const h = b?.hourly;
  if (!c || !h || !Array.isArray(h.time)) throw new AirUnavailableError("Open-Meteo answer is missing current or hourly");
  const nowHour = c.time;
  if (typeof nowHour !== "string" || !HOUR.test(nowHour)) throw new AirUnavailableError("bad current time");
  const start = h.time.findIndex((t) => typeof t === "string" && t >= nowHour);
  if (start < 0) throw new AirUnavailableError("hourly series has no hours from now");
  const hourly = h.time.slice(start, start + MAX_FORECAST_HOURS).map((time, j) => {
    const i = start + j;
    if (typeof time !== "string" || !HOUR.test(time)) throw new AirUnavailableError("bad hourly time");
    return { time: `${time}:00Z`, usAqi: num(h.us_aqi?.[i]), pm25: num(h.pm2_5?.[i]) };
  });
  const usAqi = num(c.us_aqi);
  return {
    current: { usAqi, category: category(usAqi), pm25: num(c.pm2_5), pm10: num(c.pm10), ozone: num(c.ozone), no2: num(c.nitrogen_dioxide) },
    hourly,
    asOf,
  };
}

export function openMeteoSource(fetchImpl: Fetch, now: () => number = Date.now): AirSource {
  const cache = new Map<CityId, { at: number; value: Promise<Reading> }>();
  return {
    get(city) {
      const hit = cache.get(city);
      if (hit && now() - hit.at < CACHE_MS) return hit.value;
      const { latitude, longitude } = CITIES[city];
      // forecast_days=3: the hourly series starts at midnight UTC, so 3 days always cover 48 hours from now.
      const url = "https://air-quality-api.open-meteo.com/v1/air-quality"
        + `?latitude=${latitude}&longitude=${longitude}`
        + "&current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide"
        + "&hourly=us_aqi,pm2_5&timezone=UTC&forecast_days=3";
      // Concurrent first requests share one fetch.
      const value = (async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
        if (!res?.ok) throw new AirUnavailableError("Open-Meteo is unavailable");
        return parseOpenMeteo(await res.json(), new Date(now()).toISOString());
      })();
      cache.set(city, { at: now(), value });
      value.catch(() => { if (cache.get(city)?.value === value) cache.delete(city); });
      return value;
    },
  };
}
