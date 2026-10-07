import { afterEach, describe, expect, it } from "vitest";
import { createGatewayClient } from "../src/gateway.js";
import { createLeakCheck, leakProblem } from "../src/leakCheck.js";
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

describe("gateway DNS check (the one the ownership page asks)", () => {
  it("POSTs to /internal/challenge/:apiId/check and returns the answer", async () => {
    const answer = { ok: true, reason: "verified", record: "_hirakumi.a.dev", detail: "found" };
    server = await startFakeServer((req) => (req.method === "POST" && req.url === "/internal/challenge/api_1/check" ? { status: 200, body: answer } : undefined));
    expect(await createGatewayClient(server.url, "secret").checkChallenge("api_1")).toEqual(answer);
    expect(server.calls[0].headers.authorization).toBe("Bearer secret");
  });

  it("throws on an error status or an odd answer", async () => {
    server = await startFakeServer(() => ({ status: 404, body: { error: "api_not_found" } }));
    await expect(createGatewayClient(server.url, "s").checkChallenge("api_x")).rejects.toThrow(/HTTP 404/);
    await server.close();
    server = await startFakeServer(() => ({ status: 200, body: { ok: "yes" } }));
    await expect(createGatewayClient(server.url, "s").checkChallenge("api_x")).rejects.toThrow(/unexpected shape/);
  });
});

describe("leak check client (run by the web app, so the API sees the web's address)", () => {
  it("POSTs to the web's internal route with the internal token and reads the report", async () => {
    const report = { exposure: "open", endpoints: [{ opId: "a", method: "GET", path: "/a", url: "https://a.dev/a", exposure: "open", detail: "GET answered 200" }] };
    server = await startFakeServer((req) => (req.method === "POST" && req.url === "/api/internal/apis/api_1/exposure" ? { status: 200, body: { ...report, message: "x" } } : undefined));
    const r = await createLeakCheck(server.url, "secret")("api_1");
    expect(r).toEqual(report);
    expect(server.calls[0].headers.authorization).toBe("Bearer secret");
    expect(leakProblem(r)).toMatch(/^Anyone can call your API for free at https:\/\/a\.dev\/a/);
    expect(leakProblem({ exposure: "protected", endpoints: [] })).toBeNull();
    expect(leakProblem({ exposure: "unknown", endpoints: [] })).toMatch(/couldn't confirm .*Reply `publish` in a minute/);
  });

  it("throws when the web refuses", async () => {
    server = await startFakeServer(() => ({ status: 401, body: { error: "unauthorized" } }));
    await expect(createLeakCheck(server.url, "bad")("api_1")).rejects.toThrow(/HTTP 401/);
  });
});
