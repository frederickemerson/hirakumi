import { CITY_IDS, MAX_FORECAST_DAYS } from "./weather.js";

export const DEFAULT_TITLE = "Sky Weather";

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

/** OpenAPI 3.1 for this API, served at /openapi.json. GET only; with `keyed`, every operation needs X-API-Key. */
export function buildOpenApi(publicUrl: string, title: string = DEFAULT_TITLE, keyed = false) {
  return {
    openapi: "3.1.0",
    info: {
      title,
      version: "1.0.0",
      description: "Current weather and daily forecasts for 12 major cities, from Open-Meteo. asOf is when the reading was fetched.",
    },
    servers: [{ url: publicUrl }],
    ...(keyed ? { security: [{ apiKey: [] }] } : {}),
    paths: {
      "/current": {
        get: {
          operationId: "getCurrentWeather",
          summary: "Current weather in a city",
          parameters: [city],
          responses: {
            "200": {
              description: "Current weather",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["city", "temperatureC", "humidityPct", "windKph", "condition", "asOf"],
                    properties: {
                      city: { type: "string" },
                      temperatureC: { type: "number" },
                      humidityPct: { type: "number" },
                      windKph: { type: "number" },
                      condition: { type: "string" },
                      asOf: { type: "string", format: "date-time" },
                    },
                  },
                  example: { city: "Singapore", temperatureC: 31.4, humidityPct: 62, windKph: 11.2, condition: "partly cloudy", asOf: "2026-10-07T06:30:00.000Z" },
                },
              },
            },
            "400": error,
          },
        },
      },
      "/forecast": {
        get: {
          operationId: "getForecast",
          summary: "Daily forecast for a city",
          parameters: [
            city,
            {
              name: "days", in: "query", required: false,
              description: `Days to forecast, 1 to ${MAX_FORECAST_DAYS}. Default 3.`,
              schema: { type: "integer", minimum: 1, maximum: MAX_FORECAST_DAYS, default: 3 },
              example: 3,
            },
          ],
          responses: {
            "200": {
              description: "Daily forecast",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["city", "days", "asOf"],
                    properties: {
                      city: { type: "string" },
                      days: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["date", "maxC", "minC", "precipitationMm", "condition"],
                          properties: {
                            date: { type: "string", format: "date" },
                            maxC: { type: "number" },
                            minC: { type: "number" },
                            precipitationMm: { type: "number" },
                            condition: { type: "string" },
                          },
                        },
                      },
                      asOf: { type: "string", format: "date-time" },
                    },
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
