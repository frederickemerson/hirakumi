import { afterEach, describe, expect, it } from "vitest";
import { createGatewayClient } from "../src/gateway.js";
import { startFakeServer, type FakeServer } from "./helpers/fakeHttp.js";

let server: FakeServer | undefined;
afterEach(async () => server?.close());

describe("gateway client", () => {
  it("POSTs {input} to /internal/preview with the internal bearer token", async () => {
    server = await startFakeServer((req) =>
      req.method === "POST" && req.url === "/internal/preview/api_1/getPrice"
        ? { status: 200, body: { status: 200, contentType: "application/json", body: '{"price":1}', latencyMs: 12 } }
        : undefined,
    );
    const r = await createGatewayClient(server.url, "secret").preview("api_1", "getPrice", { symbol: "ADA" });
    expect(r.body).toBe('{"price":1}');
    expect(server.calls[0].headers.authorization).toBe("Bearer secret");
    expect(server.calls[0].body).toEqual({ input: { symbol: "ADA" } });
  });

  it("throws on a gateway error status", async () => {
    server = await startFakeServer(() => ({ status: 401, body: { error: "unauthorized" } }));
    await expect(createGatewayClient(server.url, "bad").preview("api_1", "getPrice", {})).rejects.toThrow(/HTTP 401/);
  });
});
