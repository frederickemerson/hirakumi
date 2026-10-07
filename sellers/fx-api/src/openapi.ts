import { SUPPORTED_CURRENCIES } from "./rateSource.js";

export const DEFAULT_TITLE = "Mika's FX Rates";

const currency = (name: "from" | "to", description: string, examples: string[]) => ({
  name,
  in: "query",
  required: true,
  description,
  schema: { type: "string", enum: [...SUPPORTED_CURRENCIES] },
  example: examples[0],
  examples: Object.fromEntries(examples.map((c) => [c.toLowerCase(), { value: c }])),
});

const errorResponse = {
  description: "Unknown currency or invalid amount",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
      examples: { unknown: { value: { error: "unknown_currency", message: `from and to must each be one of ${SUPPORTED_CURRENCIES.join(", ")}` } } },
    },
  },
};

/** `keyed`: the API needs API_KEY in X-API-Key, so the document declares it (and Hirakumi asks the seller for it). */
export function buildOpenApi(serverUrl: string, title = DEFAULT_TITLE, keyed = false): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title,
      version: "1.0.0",
      description: "Read-only foreign exchange rates between 12 major currencies, and conversions at those rates. Live rates from Coinbase, cached for 30 seconds.",
    },
    servers: [{ url: serverUrl }],
    ...(keyed ? { security: [{ apiKey: [] }] } : {}),
    paths: {
      "/rate": {
        get: {
          operationId: "getRate",
          summary: "Get the exchange rate between two currencies",
          description: "Returns how many units of `to` one unit of `from` buys, and when that rate was current. Read-only, no side effects.",
          parameters: [
            currency("from", "Currency to convert from (ISO 4217 code).", ["USD", "EUR", "GBP"]),
            currency("to", "Currency to convert to (ISO 4217 code).", ["EUR", "JPY", "SGD"]),
          ],
          responses: {
            "200": {
              description: "Current rate",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Rate" },
                  examples: { usdEur: { value: { from: "USD", to: "EUR", rate: 0.91234, asOf: "2026-10-07T08:15:10.000Z" } } },
                },
              },
            },
            "400": errorResponse,
          },
        },
      },
      "/convert": {
        get: {
          operationId: "convertAmount",
          summary: "Convert an amount from one currency to another",
          description: "Converts `amount` of `from` into `to` at the current rate, and says which rate and when it was current. Read-only, no side effects.",
          parameters: [
            currency("from", "Currency of the amount (ISO 4217 code).", ["USD", "EUR", "GBP"]),
            currency("to", "Currency to convert into (ISO 4217 code).", ["JPY", "EUR", "SGD"]),
            {
              name: "amount",
              in: "query",
              required: true,
              description: "Amount to convert, in `from`. Above 0, at most 1e12.",
              schema: { type: "number", exclusiveMinimum: 0, maximum: 1e12 },
              example: 100,
              examples: { hundred: { value: 100 }, thousand: { value: 2500.5 } },
            },
          ],
          responses: {
            "200": {
              description: "Converted amount",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Conversion" },
                  examples: { usdJpy: { value: { from: "USD", to: "JPY", amount: 100, result: 14823.1, rate: 148.231, asOf: "2026-10-07T08:15:10.000Z" } } },
                },
              },
            },
            "400": errorResponse,
          },
        },
      },
    },
    components: {
      ...(keyed ? { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } } } : {}),
      schemas: {
        Rate: {
          type: "object",
          required: ["from", "to", "rate", "asOf"],
          additionalProperties: false,
          properties: {
            from: { type: "string", enum: [...SUPPORTED_CURRENCIES], description: "Currency converted from" },
            to: { type: "string", enum: [...SUPPORTED_CURRENCIES], description: "Currency converted to" },
            rate: { type: "number", exclusiveMinimum: 0, description: "Units of `to` per one unit of `from`, six significant digits" },
            asOf: { type: "string", format: "date-time", description: "When this rate was current (ISO 8601, UTC)" },
          },
        },
        Conversion: {
          type: "object",
          required: ["from", "to", "amount", "result", "rate", "asOf"],
          additionalProperties: false,
          properties: {
            from: { type: "string", enum: [...SUPPORTED_CURRENCIES], description: "Currency of the amount" },
            to: { type: "string", enum: [...SUPPORTED_CURRENCIES], description: "Currency of the result" },
            amount: { type: "number", exclusiveMinimum: 0, description: "The amount converted, in `from`" },
            result: { type: "number", minimum: 0, description: "The amount in `to`, to 4 decimal places" },
            rate: { type: "number", exclusiveMinimum: 0, description: "The rate used: units of `to` per one unit of `from`" },
            asOf: { type: "string", format: "date-time", description: "When the rate was current (ISO 8601, UTC)" },
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
