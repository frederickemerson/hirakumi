export const PRICE_SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Price API", version: "1.0.0" },
  paths: {
    "/price": {
      get: {
        operationId: "getPrice",
        summary: "Current price for a symbol",
        parameters: [{ name: "symbol", in: "query", required: true, description: "Ticker", schema: { type: "string" }, example: "ADA" }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Price" } } } } },
      },
    },
    "/history/{symbol}": {
      get: {
        summary: "Price history",
        parameters: [
          { name: "symbol", in: "path", required: true, schema: { type: "string", enum: ["ADA", "BTC"] } },
          { name: "days", in: "query", schema: { type: "integer", default: 7 } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/alerts": {
      post: {
        operationId: "createAlert",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { symbol: { type: "string" } } }, example: { symbol: "ADA" } } } },
        responses: { "201": { description: "created" } },
      },
    },
    "/me": { get: { operationId: "me", security: [{ key: [] }], responses: { "200": { description: "ok" } } } },
    "/upload": { post: { operationId: "upload", requestBody: { content: { "text/csv": { schema: { type: "string" } } } }, responses: { "200": { description: "ok" } } } },
    "/ext": { get: { operationId: "ext", parameters: [{ name: "q", in: "query", schema: { $ref: "https://evil.example/s.json" } }], responses: { "200": { description: "ok" } } } },
  },
  components: {
    securitySchemes: { key: { type: "http", scheme: "basic" } },
    schemas: { Price: { type: "object", properties: { symbol: { type: "string" }, price: { type: "number" } } } },
  },
});
