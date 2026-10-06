// x402 v2 carries the whole signed Cardano transaction in PAYMENT-SIGNATURE. An escrow lock with its inline datum
// is about 16 KB, past Node's 16 KB default for all headers, and Caddy's X-Forwarded-* push it over (HTTP 431).
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_URL_BYTES, limitUrl, listen } from "../src/server";

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

function send(path: string, headers: Record<string, string>): Promise<number> {
  const { port } = server!.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject);
    req.end();
  });
}

async function start(): Promise<void> {
  const app = express();
  app.use(limitUrl);
  app.post("/pay", (_req, res) => { res.json({ ok: true }); });
  await new Promise<void>((resolve) => { server = listen(app, 0, resolve); });
}

describe("gateway HTTP server", () => {
  it("accepts a 40 KB payment header (a large escrow lock), not 431", async () => {
    await start();
    expect(await send("/pay", { "payment-signature": "e".repeat(40_000), "x-forwarded-for": "1.2.3.4" })).toBe(200);
  });

  it("still refuses a huge URL: 414, the handler never runs", async () => {
    await start();
    expect(await send(`/pay?q=${"A".repeat(MAX_URL_BYTES)}`, {})).toBe(414);
  });

  it("headers past 64 KB are still refused by Node", async () => {
    await start();
    expect(await send("/pay", { "payment-signature": "e".repeat(70_000) })).toBe(431);
  });
});
