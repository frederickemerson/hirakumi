import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { newBearerToken, newId, ruleHash, sha256Hex, type RuleDefinition } from "@hirakumi/core";
import type { Sql } from "@hirakumi/db";
import type { GatewayConfig } from "../src/config";
import type { MasumiPort, PaymentRequestResult, PaymentState } from "../src/masumi-port";

export type StubMode = "ok" | "empty" | "stale" | "error500" | "slow" | "html";
export type StubUpstream = {
  origin: string;
  setMode(m: StubMode): void;
  setChallenge(path: string, body: string): void;
  hits(): number;
  lastHeaders(): http.IncomingHttpHeaders | null;
  close(): Promise<void>;
};

/** Plain-HTTP seller on 127.0.0.1 (allowed by ALLOW_INSECURE_UPSTREAM=1 in vitest.config.ts). */
export async function startStubUpstream(): Promise<StubUpstream> {
  let mode: StubMode = "ok";
  let hits = 0;
  let last: http.IncomingHttpHeaders | null = null;
  const files = new Map<string, string>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname.startsWith("/.well-known/hirakumi/")) {
      const body = files.get(url.pathname);
      if (body === undefined) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/plain" }); res.end(body); return;
    }
    if (url.pathname !== "/price") { res.writeHead(404); res.end(); return; }
    hits += 1;
    last = req.headers;
    const symbol = url.searchParams.get("symbol") ?? "ADA";
    const ok = () => JSON.stringify({ symbol, price: 0.42, updatedAt: new Date().toISOString() });
    switch (mode) {
      case "ok": res.writeHead(200, { "content-type": "application/json" }); res.end(ok()); return;
      case "empty": res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return;
      case "stale":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ symbol, price: 0.42, updatedAt: new Date(Date.now() - 3_600_000).toISOString() })); return;
      case "error500": res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"boom"}'); return;
      case "html": res.writeHead(200, { "content-type": "text/html" }); res.end("<html></html>"); return;
      case "slow": setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(ok()); }, 1500); return;
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    setMode: (m) => { mode = m; },
    setChallenge: (path, body) => { files.set(path, body); },
    hits: () => hits,
    lastHeaders: () => last,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export const PRICE_INPUT_SCHEMA = {
  type: "object",
  properties: { symbol: { type: "string", minLength: 2, maxLength: 10, description: "Ticker, e.g. ADA" } },
  required: ["symbol"],
  additionalProperties: false,
};

export const PRICE_RULE: RuleDefinition = {
  version: 1,
  status: { min: 200, max: 299 },
  contentType: "application/json",
  schema: {
    type: "object",
    required: ["price", "symbol", "updatedAt"],
    properties: { price: { type: "number" }, symbol: { type: "string" }, updatedAt: { type: "string", maxAgeSeconds: 300 } },
  },
};

export type Seeded = {
  sellerId: string; apiId: string; operationId: string; opId: string; ruleId: string; ruleHash: string;
  packId: string; payTo: string;
};

export async function seedLiveApi(
  sql: Sql,
  origin: string,
  opts: { health?: "healthy" | "down"; state?: string; calls?: number; agentIdentifier?: string | null } = {},
): Promise<Seeded> {
  const sellerId = newId("sel"), apiId = newId("api"), operationId = newId("op"), ruleId = newId("rule"), packId = newId("pk");
  const payTo = `addr_test1q${randomBytes(20).toString("hex")}`;
  const hash = ruleHash(PRICE_RULE);
  await sql`insert into sellers (id, cardano_addr) values (${sellerId}, ${payTo})`;
  await sql`
    insert into apis (id, seller_id, name, origin, openapi_url, state, health, escrow_op_id, agent_identifier)
    values (${apiId}, ${sellerId}, 'Price API', ${origin}, ${`${origin}/openapi.json`}, ${opts.state ?? "live"},
            ${opts.health ?? "healthy"}, ${operationId}, ${opts.agentIdentifier === undefined ? "agent_test_1" : opts.agentIdentifier})`;
  await sql`
    insert into operations (id, api_id, op_id, method, path, input_schema, enabled, side_effects_confirmed_none)
    values (${operationId}, ${apiId}, 'getPrice', 'GET', '/price', ${sql.json(PRICE_INPUT_SCHEMA)}, true, true)`;
  await sql`
    insert into rules (id, operation_id, version, definition, hash, plain_english)
    values (${ruleId}, ${operationId}, 1, ${sql.json(PRICE_RULE as never)}, ${hash},
            'The answer has a symbol, a number price and a timestamp from the last 5 minutes.')`;
  await sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values (${packId}, ${apiId}, ${opts.calls ?? 100}, 2000000, 1000000)`;
  await sql`insert into test_inputs (id, operation_id, input) values (${newId("ti")}, ${operationId}, ${sql.json({ symbol: "ADA" })})`;
  return { sellerId, apiId, operationId, opId: "getPrice", ruleId, ruleHash: hash, packId, payTo };
}

/** Inserts an already-settled credit token and returns the raw bearer token. */
export async function insertActiveToken(sql: Sql, s: Seeded, remaining = 100, status = "active"): Promise<{ token: string; id: string }> {
  const token = newBearerToken();
  const id = newId("ct");
  await sql`
    insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash)
    values (${id}, ${s.apiId}, ${s.packId}, ${sha256Hex(token)}, ${status}, ${remaining}, ${sha256Hex(id)})`;
  return { token, id };
}

/** Test stand-in for decoding a Cardano transaction: any string is a "transaction" except "unreadable". */
export function fakeTxHash(transaction: string): string | null {
  return transaction === "unreadable" ? null : sha256Hex(`tx:${transaction}`);
}

export class FakeFacilitator implements FacilitatorClient {
  settleMode: "success" | "fail" = "success";
  verifyCalls = 0;
  settleCalls = 0;
  async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    return { isValid: true, payer: "addr_test1qbuyer" };
  }
  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls += 1;
    if (this.settleMode === "fail") {
      return { success: false, errorReason: "exact_cardano_settlement_failed", transaction: "", network: r.network };
    }
    return { success: true, transaction: fakeTxHash(String((p.payload as { transaction?: unknown }).transaction)) ?? "", network: r.network, payer: "addr_test1qbuyer" };
  }
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: "cardano:preprod",
                extra: { assetTransferMethods: ["default"], areFeesSponsored: false, l1Confirmations: { minimum: 0, maximum: 20 } } }],
      extensions: [],
      signers: {},
    };
  }
}

export class FakeMasumi implements MasumiPort {
  state: PaymentState = "WaitingForPayment";
  created: Array<{ agentIdentifier: string; inputHash: string; identifierFromPurchaser: string; sellerReturnAddress?: string }> = [];
  submitted: Array<{ blockchainIdentifier: string; resultHash: string }> = [];
  async createPaymentRequest(p: { agentIdentifier: string; inputHash: string; identifierFromPurchaser: string; submitResultTime: Date; payByTime: Date; sellerReturnAddress?: string }): Promise<PaymentRequestResult> {
    this.created.push({ agentIdentifier: p.agentIdentifier, inputHash: p.inputHash, identifierFromPurchaser: p.identifierFromPurchaser, ...(p.sellerReturnAddress ? { sellerReturnAddress: p.sellerReturnAddress } : {}) });
    return {
      blockchainIdentifier: `bc_${randomBytes(8).toString("hex")}`,
      payByTime: p.payByTime,
      submitResultTime: p.submitResultTime,
      unlockTime: new Date(p.submitResultTime.getTime() + 20 * 60_000),
      externalDisputeUnlockTime: new Date(p.submitResultTime.getTime() + 40 * 60_000),
      sellerVKey: "vkey_test",
    };
  }
  async getPaymentState(): Promise<PaymentState> { return this.state; }
  async submitResult(blockchainIdentifier: string, resultHash: string): Promise<void> {
    this.submitted.push({ blockchainIdentifier, resultHash });
  }
}

export function testConfig(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0, publicBaseUrl: "https://gw.test", internalToken: "internal-test-token-0123456789", demoMode: true,
    facilitatorUrl: "http://facilitator.invalid", databaseUrl: "unused", probeIntervalMs: 10_000,
    thresholds: { failsToDown: 2, passesToHeal: 2 }, l1Confirmations: 0, upstreamTimeoutMs: 500,
    escrow: { payByMs: 10 * 60_000, submitResultMs: 20 * 60_000, unit: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d" }, blockfrostProjectId: null, masumi: null,
    ...over,
  };
}
// ---- appended in Task 8 ----
import type { Express } from "express";
import { createTestDb, type TestDb } from "@hirakumi/db/testing";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { HealthTracker } from "../src/health";
import { ApiRegistry } from "../src/registry";

export type Harness = {
  db: TestDb; sql: Sql; stub: StubUpstream; seeded: Seeded; health: HealthTracker; registry: ApiRegistry;
  facilitator: FakeFacilitator; masumi: FakeMasumi; config: GatewayConfig; deps: AppDeps; app: Express;
  txHashOf(transaction: string): string | null;
  close(): Promise<void>;
};

export async function makeHarness(
  opts: { config?: Partial<GatewayConfig>; seed?: Parameters<typeof seedLiveApi>[2] } = {},
): Promise<Harness> {
  const db = await createTestDb();
  const stub = await startStubUpstream();
  const seeded = await seedLiveApi(db.sql, stub.origin, opts.seed);
  const config = testConfig(opts.config);
  const health = new HealthTracker(config.thresholds);
  const registry = new ApiRegistry(db.sql, health);
  const facilitator = new FakeFacilitator();
  const masumi = new FakeMasumi();
  const deps: AppDeps = {
    sql: db.sql, config, registry, health, facilitator, masumi,
    paymentTxHash: (payload) => fakeTxHash(String(payload.transaction)),
  };
  const app = createApp(deps);
  return {
    db, sql: db.sql, stub, seeded, health, registry, facilitator, masumi, config, deps, app, txHashOf: fakeTxHash,
    async close() { await stub.close(); await db.drop(); },
  };
}
