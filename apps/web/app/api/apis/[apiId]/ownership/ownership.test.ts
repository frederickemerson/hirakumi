import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { GatewayError, setGatewayForTests, type ChallengeCheck, type Gateway } from "@/lib/gateway";
import { findVerifyCode, getOrCreateVerifyCode } from "@/lib/repo/challenges";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { makeTestWallet, type TestWallet } from "@/test/wallet-fixture";
import { POST as specCheck } from "./spec-check/route";
import { POST as verify } from "./verify/route";
import { POST as walletChallenge } from "./wallet-challenge/route";

function fakeGateway(check: Gateway["checkChallenge"]): Gateway {
  return { checkChallenge: check, reloadApi: vi.fn(async () => undefined), getHealth: vi.fn() };
}
const PASS: ChallengeCheck = { ok: true, reason: "verified", triedUrl: "https://price.example.dev/openapi.json", detail: "Found your code. The OpenAPI file is verified." };

let wallet: TestWallet;
let seller: Seller;
let api: Api;
let cookie: string;

function runCheck(asCookie = cookie, id = api.id) {
  return specCheck(jsonRequest(`/api/apis/${id}/ownership/spec-check`, { cookie: asCookie, body: {} }), ctx(id));
}

async function passSpecCheck() {
  setGatewayForTests(fakeGateway(async () => PASS));
  const res = await runCheck();
  expect(res.status).toBe(200);
}

async function getWalletMessage() {
  const res = await walletChallenge(jsonRequest(`/api/apis/${api.id}/ownership/wallet-challenge`, { cookie, body: {} }), ctx(api.id));
  return { res, body: (await res.json()) as { challengeId: string; message: string; error?: string } };
}

function sendVerify(body: Record<string, unknown>, asCookie = cookie) {
  return verify(jsonRequest(`/api/apis/${api.id}/ownership/verify`, { cookie: asCookie, body }), ctx(api.id));
}

async function apiState() {
  const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
  return row.state;
}

describe("ownership", () => {
  beforeEach(async () => {
    await resetDb();
    wallet = await makeTestWallet();
    seller = await seedSeller(wallet.bech32);
    api = await seedApi(seller.id, "endpoints_confirmed");
    cookie = cookieFor(seller);
  });
  afterEach(() => setGatewayForTests(null));

  it("gives each API its own unguessable code, the same on every visit", async () => {
    const a = await getOrCreateVerifyCode(getSql(), api.id);
    const b = await getOrCreateVerifyCode(getSql(), api.id);
    expect(a.code).toMatch(/^hkv_[A-Za-z0-9_-]{43}$/);
    expect(b.code).toBe(a.code);
    const other = await seedApi(seller.id, "endpoints_confirmed", { openapiUrl: "https://price.example.dev/openapi.json" });
    expect((await getOrCreateVerifyCode(getSql(), other.id)).code).not.toBe(a.code);
  });

  it("records a pass only when the gateway found this API's code, then unlocks signing", async () => {
    setGatewayForTests(fakeGateway(async () => ({ ok: false, reason: "missing", triedUrl: PASS.triedUrl, detail: "no field" })));
    const failed = await runCheck();
    expect(await failed.json()).toEqual({ ok: false, reason: "missing", triedUrl: PASS.triedUrl, detail: "no field" });
    expect((await getWalletMessage()).res.status).toBe(409);
    await passSpecCheck();
    expect((await findVerifyCode(getSql(), api.id))?.passedAt).toBeTruthy();
    expect((await getWalletMessage()).res.status).toBe(200);
  });

  it("passes the fetch status through", async () => {
    const r404: ChallengeCheck = { ok: false, reason: "http_status", status: 404, triedUrl: PASS.triedUrl, detail: "Your server answered 404, not 200." };
    setGatewayForTests(fakeGateway(async () => r404));
    expect(await (await runCheck()).json()).toEqual(r404);
  });

  it("a pass for one API never unlocks another API of the same seller on the same origin", async () => {
    const other = await seedApi(seller.id, "endpoints_confirmed");
    const check = vi.fn(async (id: string) => (id === api.id ? PASS : { ...PASS, ok: false, reason: "mismatch" as const, detail: "wrong code" }));
    setGatewayForTests(fakeGateway(check));
    await runCheck();
    await runCheck(cookie, other.id);
    expect(check.mock.calls.map((c) => c[0])).toEqual([api.id, other.id]);
    const res = await walletChallenge(jsonRequest(`/x`, { cookie, body: {} }), ctx(other.id));
    expect(res.status).toBe(409);
  });

  it("a pass older than 30 minutes no longer unlocks signing", async () => {
    await passSpecCheck();
    await getSql()`update challenges set proof = jsonb_set(proof, '{passedAt}', to_jsonb((now() - interval '31 minutes')::text)) where api_id = ${api.id} and kind = 'openapi'`;
    const { res, body } = await getWalletMessage();
    expect(res.status).toBe(409);
    expect(body.error).toBe("Check your OpenAPI file first.");
  });

  it("answers 502 in plain English when the gateway is unreachable", async () => {
    setGatewayForTests(fakeGateway(async () => {
      throw new GatewayError("We couldn't reach the Hirakumi checker. Try again in a minute.", "ECONNREFUSED");
    }));
    const res = await runCheck();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "We couldn't reach the Hirakumi checker. Try again in a minute." });
  });

  it("refuses to issue a wallet message before the OpenAPI check passed", async () => {
    const { res, body } = await getWalletMessage();
    expect(res.status).toBe(409);
    expect(body.error).toBe("Check your OpenAPI file first.");
  });

  it("verifies the owner's signature, moves to ownership_verified and consumes the code", async () => {
    await passSpecCheck();
    const { body } = await getWalletMessage();
    expect(body.message).toContain(api.id);
    expect(body.message).toContain(wallet.bech32);
    expect(body.message).toContain("https://price.example.dev");
    const res = await sendVerify({ challengeId: body.challengeId, address: wallet.addressHex, ...wallet.sign(body.message) });
    expect(res.status).toBe(200);
    expect(await apiState()).toBe("ownership_verified");
    const open = await getSql()<{ kind: string }[]>`
      select kind from challenges where api_id = ${api.id} and consumed_at is null`;
    expect(open).toEqual([]);
    expect(await findVerifyCode(getSql(), api.id)).toBeNull();
  });

  it("rejects a signature from a different wallet", async () => {
    await passSpecCheck();
    const { body } = await getWalletMessage();
    const other = await makeTestWallet();
    const res = await sendVerify({ challengeId: body.challengeId, address: other.addressHex, ...other.sign(body.message) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/^You signed with a different wallet/);
    const res2 = await sendVerify({ challengeId: body.challengeId, ...other.sign(body.message) });
    expect(res2.status).toBe(401);
    expect(await apiState()).toBe("endpoints_confirmed");
  });

  it("refuses to reuse a consumed challenge", async () => {
    await passSpecCheck();
    const { body } = await getWalletMessage();
    const signed = { challengeId: body.challengeId, ...wallet.sign(body.message) };
    expect((await sendVerify(signed)).status).toBe(200);
    await getSql()`update apis set state = 'endpoints_confirmed' where id = ${api.id}`;
    expect((await sendVerify(signed)).status).toBe(409);
  });

  it("refuses an expired challenge", async () => {
    await passSpecCheck();
    const { body } = await getWalletMessage();
    await getSql()`update challenges set expires_at = now() - interval '1 minute' where id = ${body.challengeId}`;
    const res = await sendVerify({ challengeId: body.challengeId, ...wallet.sign(body.message) });
    expect(res.status).toBe(409);
    expect(await apiState()).toBe("endpoints_confirmed");
  });

  it("returns 404 for another seller's API and never asks the gateway", async () => {
    const intruder = await seedSeller();
    const check = vi.fn(async () => PASS);
    setGatewayForTests(fakeGateway(check));
    const res = await runCheck(cookieFor(intruder));
    expect(res.status).toBe(404);
    expect(check).not.toHaveBeenCalled();
    expect(await findVerifyCode(getSql(), api.id)).toBeNull();
  });
});
