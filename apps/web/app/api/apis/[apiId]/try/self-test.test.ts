import { beforeEach, describe, expect, it, vi } from "vitest";
import { newId, sha256Hex } from "@hirakumi/core";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { getSql } from "@/lib/db";
import { createSelfTestHandlers, type SelfTestDeps } from "@/lib/self-test";
import { findSelfTestPack, getSelfTestStatus } from "@/lib/self-test-repo";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedPack, seedRule, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST as callRoute } from "./route";
import { POST as freeRoute } from "./free/route";
import { GET as receiptsRoute } from "./receipts/route";
import { POST as prepareRoute } from "./pay/prepare/route";
import { POST as payRoute } from "./pay/route";

const GATEWAY = "https://api.hirakumi.test";
const UNSIGNED_TX = "84a3008001800200a0f5f6";
const WITNESS = `a10081825820${"11".repeat(32)}5840${"22".repeat(64)}`;
const NONCE = `${"ab".repeat(32)}#0`;

let seller: Seller;
let api: Api;
let packId: string;

beforeEach(async () => {
  await resetDb();
  seller = await seedSeller();
  api = await seedApi(seller.id, "live");
  const op = await seedOperation(api.id, { enabled: true });
  await seedRule(op.id);
  packId = (await seedPack(api.id, { calls: 100, priceMicros: "2000000" })).id;
});

type Route = (req: Request, c: { params: Promise<{ apiId: string }> }) => Promise<Response>;
const ROUTES: [string, Route, string, unknown][] = [
  ["call", callRoute, "POST", { opId: "getPrice", method: "GET", input: {} }],
  ["free", freeRoute, "POST", {}],
  ["receipts", receiptsRoute, "GET", undefined],
  ["prepare", prepareRoute, "POST", { utxos: ["00"], changeAddress: "00" }],
  ["pay", payRoute, "POST", { tx: UNSIGNED_TX, witnessSet: WITNESS, nonce: NONCE, priceMicros: "2000000" }],
];
const req = (method: string, body: unknown, headers: Record<string, string> = {}, cookie?: string) => {
  const r = jsonRequest(`/api/apis/${api.id}/try`, { method, cookie, body });
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
};

describe("seller Try it live: who may use it", () => {
  it("signed out: 401 on every route, and nothing reaches the gateway", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const [name, h, method, body] of ROUTES) expect((await h(req(method, body), ctx(api.id))).status, name).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("another seller: 404 on every route", async () => {
    const other = await seedSeller();
    for (const [name, h, method, body] of ROUTES) {
      expect((await h(req(method, body, {}, cookieFor(other)), ctx(api.id))).status, name).toBe(404);
    }
  });

  it("the owner's session sent cross-site: 403 on every state-changing route", async () => {
    for (const [name, h, method, body] of ROUTES.filter((r) => r[2] !== "GET")) {
      for (const headers of [{ "sec-fetch-site": "cross-site" }, { origin: "https://evil.example" }]) {
        expect((await h(req(method, body, headers, cookieFor(seller)), ctx(api.id))).status, name).toBe(403);
      }
    }
  });

  it("an API that isn't live: 409", async () => {
    await getSql()`update apis set state = 'priced' where id = ${api.id}`;
    for (const [name, h, method, body] of ROUTES) {
      expect((await h(req(method, body, {}, cookieFor(seller)), ctx(api.id))).status, name).toBe(409);
    }
  });
});

/** The gateway's 402 for the pack, as x402 sends it: tUSDM on preprod, paid direct to `payTo`. */
function offer(payTo: string, amount = "2000000"): Response {
  const url = `${GATEWAY}/a/${api.id}/packs/${packId}/buy`;
  const header = encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url, description: "pack", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: "cardano:preprod", asset: USDM_PREPROD_ASSET, amount, payTo, maxTimeoutSeconds: 600, extra: { calls: 100 } }],
  });
  return new Response(JSON.stringify({ error: "payment_required", mode: "direct" }), { status: 402, headers: { "payment-required": header, "content-type": "application/json" } });
}

function handlers(fetchImpl: typeof fetch, over: Partial<SelfTestDeps> = {}) {
  return createSelfTestHandlers({
    gatewayInternalUrl: "https://gateway.hirakumi.test", internalToken: "test-internal-token", gatewayBase: GATEWAY,
    allowBuy: () => true, allowCall: () => true, fetchImpl,
    build: vi.fn(async () => ({ tx: UNSIGNED_TX, nonce: NONCE, feeLovelace: "180000" })),
    ...over,
  });
}
const own = (body?: unknown, method = "POST") => req(method, body, {}, cookieFor(seller));

describe("the free test", () => {
  it("asks the gateway's self-test route (not the showcase's) with the internal token and streams it back", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const h = handlers(vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response('{"phase":"paying"}\n', { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }) as typeof fetch);
    const res = await h.free(own(), ctx(api.id));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("paying");
    expect(seen).toEqual([{ url: `https://gateway.hirakumi.test/internal/demo/self-test/${api.id}`, auth: "Bearer test-internal-token" }]);
  });

  it("passes the gateway's refusal on (free test used, or the seller's cap)", async () => {
    const h = handlers(vi.fn(async () => new Response(JSON.stringify({ error: "free_test_used", message: "You already used the free test for this API." }), { status: 409 })) as typeof fetch);
    const res = await h.free(own(), ctx(api.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already used the free test/);
  });

  it("once per listing, enforced by the database even when two writes race", async () => {
    const insert = () => getSql()`insert into try_tokens (id, api_id, status, self_test_seller_id) values (${newId("try")}, ${api.id}, 'buying', ${seller.id})`;
    const results = await Promise.allSettled(Array.from({ length: 8 }, insert));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await getSelfTestStatus(getSql(), api.id, seller.id)).toEqual({ freeTestUsed: true, freeTestsLeft: 2 });
  });

  it("the free pack powers this seller's console only, never the public one", async () => {
    await getSql()`insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash)
      values ('ct_free', ${api.id}, ${packId}, ${sha256Hex("hk_free")}, 'active', 100, 'pp')`;
    await getSql()`insert into try_tokens (id, api_id, status, token, token_hash, self_test_seller_id)
      values (${newId("try")}, ${api.id}, 'active', 'hk_free', ${sha256Hex("hk_free")}, ${seller.id})`;
    expect(await findSelfTestPack(getSql(), api.id, seller.id)).toMatchObject({ token: "hk_free", remaining: 100, source: "live" });
    const other = await seedSeller();
    expect(await findSelfTestPack(getSql(), api.id, other.id)).toBeNull();
    const { findTryPack } = await import("@/lib/try-repo");
    expect(await findTryPack(getSql(), api.id, undefined)).toBeNull();
  });
});

describe("paying with the seller's own wallet", () => {
  it("prepare: reads the gateway's 402 with no escrow headers and builds the payment to the seller's own address", async () => {
    const sent: Headers[] = [];
    const build = vi.fn(async () => ({ tx: UNSIGNED_TX, nonce: NONCE, feeLovelace: "180000" }));
    const h = handlers(vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return offer(seller.cardanoAddr);
    }) as typeof fetch, { build });
    const res = await h.prepare(own({ utxos: ["8282", "8283"], changeAddress: "00ab" }), ctx(api.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tx: UNSIGNED_TX, nonce: NONCE, feeLovelace: "180000", priceMicros: "2000000", calls: 100 });
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ utxos: ["8282", "8283"], changeAddress: "00ab", payTo: seller.cardanoAddr, amount: 2_000_000n }));
    expect(sent[0].get("x-hirakumi-receipt-key")).toBeNull();
    expect(sent[0].get("x-hirakumi-settlement")).toBeNull();
  });

  it("prepare refuses an escrow offer: nothing is built or paid", async () => {
    const build = vi.fn();
    const h = handlers(vi.fn(async () => offer("addr_test1wescrowscriptaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")) as typeof fetch, { build });
    const res = await h.prepare(own({ utxos: ["8282"], changeAddress: "00ab" }), ctx(api.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/escrow/);
    expect(build).not.toHaveBeenCalled();
  });

  it("prepare explains an escrow-only gateway", async () => {
    const h = handlers(vi.fn(async () => new Response(JSON.stringify({ error: "receipt_key_required" }), { status: 400 })) as typeof fetch);
    const res = await h.prepare(own({ utxos: ["8282"], changeAddress: "00ab" }), ctx(api.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/escrow only/);
  });

  it("pay: sends the signed transaction through x402, keeps the token server-side, and the console uses it", async () => {
    let paid: ReturnType<typeof decodePaymentSignatureHeader> | null = null;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const h = new Headers(init?.headers);
      if (u.endsWith("/buy") && !h.get("payment-signature")) return offer(seller.cardanoAddr);
      if (u.endsWith("/buy")) {
        paid = decodePaymentSignatureHeader(h.get("payment-signature")!);
        await getSql()`insert into credit_tokens (id, api_id, pack_id, token_hash, payer, status, remaining, payment_payload_hash)
          values ('ct_wallet', ${api.id}, ${packId}, ${sha256Hex("hk_wallet_token")}, ${seller.cardanoAddr}, 'active', 100, 'pp_w')`;
        return new Response(JSON.stringify({ token: "hk_wallet_token", credits: 100, apiId: api.id, mode: "direct" }), { status: 200 });
      }
      // The paid call through the gateway.
      expect(h.get("authorization")).toBe("Bearer hk_wallet_token");
      return new Response(JSON.stringify({ price: 1 }), { status: 200, headers: { "content-type": "application/json", "x-credits-remaining": "99" } });
    }) as typeof fetch;
    const h = handlers(fetchImpl);
    const res = await h.pay(own({ tx: UNSIGNED_TX, witnessSet: WITNESS, nonce: NONCE, priceMicros: "2000000" }), ctx(api.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ credits: 100, txHash: null, pending: false });
    expect(JSON.stringify(body)).not.toContain("hk_wallet_token");
    // The payment carried the transaction the wallet signed (with its witness) and the nonce it was built on.
    const payload = (paid as unknown as { payload: { transaction: string; nonce: string }; accepted: { payTo: string } });
    expect(payload.payload.nonce).toBe(NONCE);
    expect(Buffer.from(payload.payload.transaction, "base64").toString("hex")).toContain("11".repeat(32));
    expect(payload.accepted.payTo).toBe(seller.cardanoAddr);
    expect(await findSelfTestPack(getSql(), api.id, seller.id)).toMatchObject({ token: "hk_wallet_token", source: "wallet" });

    const call = await h.call(own({ opId: "getPrice", method: "GET", input: {} }), ctx(api.id));
    expect(call.status).toBe(200);
    expect((await call.json()).receipt.receiptsUrl).toBe(`/api/apis/${api.id}/try/receipts`);
  });

  it("pay refuses when the price changed after signing, and pays nothing", async () => {
    let paidCalls = 0;
    const h = handlers(vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).get("payment-signature")) paidCalls += 1;
      return offer(seller.cardanoAddr, "3000000");
    }) as typeof fetch);
    const res = await h.pay(own({ tx: UNSIGNED_TX, witnessSet: WITNESS, nonce: NONCE, priceMicros: "2000000" }), ctx(api.id));
    expect(res.status).toBe(409);
    expect(paidCalls).toBe(0);
  });

  it("pay rejects malformed input before anything else", async () => {
    const fetchImpl = vi.fn();
    const h = handlers(fetchImpl as unknown as typeof fetch);
    for (const b of [{}, { tx: "zz", witnessSet: WITNESS, nonce: NONCE, priceMicros: "1" }, { tx: UNSIGNED_TX, witnessSet: WITNESS, nonce: "x#0", priceMicros: "1" }]) {
      expect((await h.pay(own(b), ctx(api.id))).status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a call with no self-test pack asks for one", async () => {
    const h = handlers(vi.fn() as unknown as typeof fetch);
    const res = await h.call(own({ opId: "getPrice", method: "GET", input: {} }), ctx(api.id));
    expect(res.status).toBe(409);
    expect((await res.json()).needsPack).toBe(true);
  });
});
