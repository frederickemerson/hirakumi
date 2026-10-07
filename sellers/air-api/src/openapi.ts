import { CITY_IDS, DEFAULT_FORECAST_HOURS, MAX_FORECAST_HOURS } from "./air.js";

export const DEFAULT_TITLE = "Clean Air";

const city = {
  name: "city", in: "query", required: true,
  description: "City id.",
  schema: { type: "string", enum: CITY_IDS },
  example: "singapore",
};

const error = {
  description: "Bad input",
  content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } } } } },
};

const CATEGORIES = ["good", "moderate", "unhealthy for sensitive groups", "unhealthy", "very unhealthy", "hazardous"];

/** OpenAPI 3.1 for this API, served at /openapi.json. GET only; with `keyed`, every operation needs X-API-Key. */
export function buildOpenApi(publicUrl: string, title: string = DEFAULT_TITLE, keyed = false) {
  return {
    openapi: "3.1.0",
    info: {
      title,
      version: "1.0.0",
      description:
        "Current air quality (US AQI with its EPA category, PM2.5, PM10, ozone, NO2 in ug/m3) and hourly AQI forecasts for 12 major cities, from Open-Meteo. asOf is when the reading was fetched.",
    },
    servers: [{ url: publicUrl }],
    ...(keyed ? { security: [{ apiKey: [] }] } : {}),
    paths: {
      "/now": {
        get: {
          operationId: "getCurrentAirQuality",
          summary: "Current air quality in a city",
          parameters: [city],
          responses: {
            "200": {
              description: "Current air quality",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["city", "usAqi", "category", "pm25", "pm10", "ozone", "no2", "asOf"],
                    properties: {
                      city: { type: "string" },
                      usAqi: { type: "number", description: "US EPA Air Quality Index" },
                      category: { type: "string", enum: CATEGORIES },
                      pm25: { type: "number", description: "PM2.5, ug/m3" },
                      pm10: { type: "number", description: "PM10, ug/m3" },
                      ozone: { type: "number", description: "Ozone, ug/m3" },
                      no2: { type: "number", description: "Nitrogen dioxide, ug/m3" },
                      asOf: { type: "string", format: "date-time" },
                    },
                  },
                  example: { city: "Singapore", usAqi: 62, category: "moderate", pm25: 18.4, pm10: 27.1, ozone: 41, no2: 22.5, asOf: "2026-10-07T06:30:00.000Z" },
                },
              },
            },
            "400": error,
          },
        },
      },
      "/forecast": {
        get: {
          operationId: "getAirQualityForecast",
          summary: "Hourly air quality forecast for a city",
          parameters: [
            city,
            {
              name: "hours", in: "query", required: false,
              description: `Hours to forecast from the current hour, 1 to ${MAX_FORECAST_HOURS}. Default ${DEFAULT_FORECAST_HOURS}.`,
              schema: { type: "integer", minimum: 1, maximum: MAX_FORECAST_HOURS, default: DEFAULT_FORECAST_HOURS },
              example: DEFAULT_FORECAST_HOURS,
            },
          ],
          responses: {
            "200": {
              description: "Hourly forecast",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["city", "hours", "asOf"],
                    properties: {
                      city: { type: "string" },
                      hours: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["time", "usAqi", "pm25"],
                          properties: {
                            time: { type: "string", format: "date-time" },
                            usAqi: { type: "number" },
                            pm25: { type: "number" },
                          },
                        },
                      },
                      asOf: { type: "string", format: "date-time" },
                    },
                  },
                  example: {
                    city: "Singapore",
                    hours: [{ time: "2026-10-07T06:00:00Z", usAqi: 62, pm25: 18.4 }, { time: "2026-10-07T07:00:00Z", usAqi: 65, pm25: 19.2 }],
                    asOf: "2026-10-07T06:30:00.000Z",
                  },
                },
              },
            },
            "400": error,
          },
        },
      },
    },
    ...(keyed ? { components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } } } } : {}),
  };
}
