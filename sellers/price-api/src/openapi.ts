import { SUPPORTED_SYMBOLS } from "./priceSource.js";

export function buildOpenApi(serverUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Hirakumi Demo Price API",
      version: "1.0.0",
      description: "Read-only spot price in US dollars and 24-hour change for a few crypto assets. Data from CoinGecko, cached for 30 seconds.",
    },
    servers: [{ url: serverUrl }],
    paths: {
      "/price": {
        get: {
          operationId: "getPrice",
          summary: "Get the current US dollar price of a crypto asset",
          description: "Returns the latest spot price, the 24-hour percentage change and the time the price was last updated. Read-only, no side effects.",
          parameters: [
            {
              name: "symbol",
              in: "query",
              required: true,
              description: "Ticker symbol of the asset.",
              schema: { type: "string", enum: [...SUPPORTED_SYMBOLS] },
              example: "ADA",
              examples: { ada: { value: "ADA" }, btc: { value: "BTC" }, eth: { value: "ETH" } },
            },
          ],
          responses: {
            "200": {
              description: "Current price",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Price" },
                  examples: {
                    ada: { value: { symbol: "ADA", usd: 0.2695, change24h: 1.25, timestamp: "2026-10-06T08:15:10.000Z" } },
                  },
                },
              },
            },
            "400": {
              description: "Unknown symbol",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                  examples: { unknown: { value: { error: "unknown_symbol", message: "symbol must be one of ADA, BTC, ETH, SOL" } } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Price: {
          type: "object",
          required: ["symbol", "usd", "change24h", "timestamp"],
          additionalProperties: false,
          properties: {
            symbol: { type: "string", enum: [...SUPPORTED_SYMBOLS], description: "Ticker symbol" },
            usd: { type: "number", minimum: 0, description: "Spot price in US dollars" },
            change24h: { type: "number", description: "Percentage change over the last 24 hours" },
            timestamp: { type: "string", format: "date-time", description: "When the price was last updated (ISO 8601, UTC)" },
          },
        },
        Error: {
          type: "object",
          required: ["error", "message"],
          properties: { error: { type: "string" }, message: { type: "string" } },
        },
      },
    },
  };
}
