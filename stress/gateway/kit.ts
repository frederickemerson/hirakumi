// Shared kit for the in-process gateway abuse tests: the gateway's own test harness (fresh schema, fake
// facilitator, fake chain) served on a real local port, a scriptable hostile seller, and tally helpers.
// Local only: every server here listens on 127.0.0.1.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, request as undiciRequest } from "undici";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import type { Express } from "express";
import { listen } from "../../apps/gateway/src/server";
import { fakeTxHash } from "../../apps/gateway/test/helpers";

export { fakeTxHash, makeHarness, seedLiveApi, insertActiveToken, anotherBase, type Harness } from "../../apps/gateway/test/helpers";
export { FakeEscrowChain } from "../../apps/gateway/test/fakeChain";

export const LONG = process.env.STRESS_LONG === "1";
/** Scales a count for --long runs. */
export const scale = (n: number, long = n * 10) => (LONG ? long : n);

export const SELLER = "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y";
export const FEE = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
export const BUYER = "addr_test1qzcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6sfs370w";

export const tally = <T extends string | number>(xs: T[]) =>
  xs.reduce<Record<string, number>>((m, x) => ((m[String(x)] = (m[String(x)] ?? 0) + 1), m), {});

/** A real HTTP server for the app (Node's parser, the gateway's 64 KB header limit) and a pooled client. */
export async function serve(app: Express) {
  const server = await new Promise<http.Server>((resolve) => { const s = listen(app, 0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const agent = new Agent({ connections: 256, pipelining: 1, keepAliveTimeout: 5_000 });
  async function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    const r = await undiciRequest(base + path, { method: (init.method ?? "GET") as "GET", headers: init.headers, body: init.body, dispatcher: agent });
    const text = await r.body.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.statusCode, headers: r.headers, text, json };
  }
  return {
    base, port, server, req,
    async close() { await agent.close(); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); },
  };
}

export type SellerReply = { status?: number; headers?: Record<string, string>; body?: string | Buffer } | "hang" | "stream" | "destroy";
/** A seller whose every /price answer is decided by `reply` (default: an answer the price rule keeps). */
export async function startHostileSeller() {
  let reply: (req: http.IncomingMessage, n: number) => SellerReply | Promise<SellerReply> = () => ({});
  let hits = 0;
  const sockets = new Set<import("node:net").Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer(async (req, res) => {
    hits += 1;
    const url = new URL(req.url ?? "/", "http://seller");
    const r = await reply(req, hits);
    if (r === "hang") return; // never answers
    if (r === "destroy") { req.socket.destroy(); return; }
    if (r === "stream") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"symbol":"ADA","price":0.42,"pad":"');
      const t = setInterval(() => { if (!res.write("x".repeat(64 * 1024))) { /* backpressure: keep going anyway */ } }, 5);
      timers.add(t);
      res.on("close", () => { clearInterval(t); timers.delete(t); });
      return;
    }
    const body = r.body ?? JSON.stringify({ symbol: url.searchParams.get("symbol") ?? "ADA", price: 0.42, updatedAt: new Date().toISOString() });
    res.writeHead(r.status ?? 200, { "content-type": "application/json", ...r.headers });
    res.end(body);
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    hits: () => hits,
    setReply(f: typeof reply) { reply = f; },
    async close() {
      for (const t of timers) clearInterval(t);
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r(null)));
    },
  };
}

export const passingBody = (symbol = "ADA") => JSON.stringify({ symbol, price: 0.42, updatedAt: new Date().toISOString() });

export async function offerOf(res: { status: number; headers: Record<string, string | string[] | undefined> }) {
  const raw = res.headers["payment-required"];
  if (!raw) return null;
  return decodePaymentRequiredHeader(String(raw));
}

/** The PAYMENT-SIGNATURE a buyer would send for `accepted`, with a fake transaction id. */
export function paymentHeader(required: { x402Version: number; resource?: unknown }, accepted: PaymentRequirements, transaction: string, nonce = "n") {
  return encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource as never, accepted, payload: { transaction, nonce } });
}

export const txHash = (transaction: string) => fakeTxHash(transaction)!;

