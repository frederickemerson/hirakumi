import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

const KEY = "mika-key-0123456789";

describe("API_KEY", () => {
  it("refuses data calls without the key, and answers them with it", async () => {
    const app = makeApp({ apiKey: KEY });
    const none = await request(app).get("/rate?from=USD&to=EUR");
    expect(none.status).toBe(401);
    expect(none.body.error).toBe("api_key_required");
    expect((await request(app).get("/convert?from=USD&to=EUR&amount=5").set("X-API-Key", "wrong")).status).toBe(401);
    const ok = await request(app).get("/rate?from=USD&to=EUR").set("X-API-Key", KEY);
    expect(ok.status).toBe(200);
    expect(ok.body.from).toBe("USD");
  });

  it("keeps health and the OpenAPI document public, and declares the key there", async () => {
    const app = makeApp({ apiKey: KEY });
    expect((await request(app).get("/healthz")).status).toBe(200);
    const doc = (await request(app).get("/openapi.json")).body;
    expect(doc.components.securitySchemes.apiKey).toEqual({ type: "apiKey", in: "header", name: "X-API-Key" });
    expect(doc.security).toEqual([{ apiKey: [] }]);
  });

  it("is open, with no security in the document, when API_KEY is unset", async () => {
    const app = makeApp();
    expect((await request(app).get("/rate?from=USD&to=EUR")).status).toBe(200);
    const doc = (await request(app).get("/openapi.json")).body;
    expect(doc.security).toBeUndefined();
    expect(doc.components.securitySchemes).toBeUndefined();
  });
});
