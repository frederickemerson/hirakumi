// Weather from Open-Meteo (free, no key). Cached per city; never an invented reading: no real data means a 503.

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

export const MAX_FORECAST_DAYS = 7;
export const CACHE_MS = 60_000;

/** WMO weather codes (Open-Meteo's weather_code) as plain words. */
const CONDITIONS: [number[], string][] = [
  [[0], "clear"], [[1, 2], "partly cloudy"], [[3], "overcast"], [[45, 48], "fog"],
  [[51, 53, 55, 56, 57], "drizzle"], [[61, 63, 65, 66, 67, 80, 81, 82], "rain"],
  [[71, 73, 75, 77, 85, 86], "snow"], [[95, 96, 99], "thunderstorm"],
];
export function condition(code: number): string {
  return CONDITIONS.find(([codes]) => codes.includes(code))?.[1] ?? "unknown";
}

export type Reading = {
  current: { temperatureC: number; humidityPct: number; windKph: number; condition: string };
  daily: { date: string; maxC: number; minC: number; precipitationMm: number; condition: string }[];
  /** When this service fetched the reading from Open-Meteo (ISO 8601, UTC). */
  asOf: string;
};

export class WeatherUnavailableError extends Error {}

export type WeatherSource = { get(city: CityId): Promise<Reading> };

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const num = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new WeatherUnavailableError("Open-Meteo sent a non-number");
  return v;
};

/** Parses Open-Meteo's /v1/forecast answer. Throws WeatherUnavailableError on anything unexpected. */
export function parseOpenMeteo(body: unknown, asOf: string): Reading {
  const b = body as { current?: Record<string, unknown>; daily?: Record<string, unknown[]> };
  const c = b?.current;
  const d = b?.daily;
  if (!c || !d || !Array.isArray(d.time)) throw new WeatherUnavailableError("Open-Meteo answer is missing current or daily");
  const daily = d.time.map((date, i) => {
    if (typeof date !== "string") throw new WeatherUnavailableError("bad daily date");
    return {
      date,
      maxC: num(d.temperature_2m_max?.[i]),
      minC: num(d.temperature_2m_min?.[i]),
      precipitationMm: num(d.precipitation_sum?.[i]),
      condition: condition(num(d.weather_code?.[i])),
    };
  });
  return {
    current: {
      temperatureC: num(c.temperature_2m),
      humidityPct: num(c.relative_humidity_2m),
      windKph: num(c.wind_speed_10m),
      condition: condition(num(c.weather_code)),
    },
    daily,
    asOf,
  };
}

export function openMeteoSource(fetchImpl: Fetch, now: () => number = Date.now): WeatherSource {
  const cache = new Map<CityId, { at: number; value: Promise<Reading> }>();
  return {
    get(city) {
      const hit = cache.get(city);
      if (hit && now() - hit.at < CACHE_MS) return hit.value;
      const { latitude, longitude } = CITIES[city];
      const url = "https://api.open-meteo.com/v1/forecast"
        + `?latitude=${latitude}&longitude=${longitude}`
        + "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code"
        + "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code"
        + `&timezone=auto&forecast_days=${MAX_FORECAST_DAYS}`;
      // Concurrent first requests share one fetch.
      const value = (async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
        if (!res?.ok) throw new WeatherUnavailableError("Open-Meteo is unavailable");
        return parseOpenMeteo(await res.json(), new Date(now()).toISOString());
      })();
      cache.set(city, { at: now(), value });
      value.catch(() => { if (cache.get(city)?.value === value) cache.delete(city); });
      return value;
    },
  };
}
