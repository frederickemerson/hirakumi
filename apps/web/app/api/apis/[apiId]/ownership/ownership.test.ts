import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { GatewayError, setGatewayForTests, type Gateway } from "@/lib/gateway";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { makeTestWallet, type TestWallet } from "@/test/wallet-fixture";
import { GET as challengeFile } from "../challenge-file/route";
import { POST as httpCheck } from "./http-check/route";
import { POST as verify } from "./verify/route";
import { POST as walletChallenge } from "./wallet-challenge/route";

function fakeGateway(check: Gateway["checkChallenge"]): Gateway {
  return { checkChallenge: check, reloadApi: vi.fn(async () => undefined), getHealth: vi.fn() };
}

let wallet: TestWallet;
let seller: Seller;
let api: Api;
let cookie: string;

async function passFileCheck() {
  setGatewayForTests(fakeGateway(async (id) => ({ ok: true, triedUrl: `https://price.example.dev/.well-known/hirakumi/${id}.txt`, detail: "The file matched." })));
  await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie }), ctx(api.id));
  const res = await httpCheck(jsonRequest(`/api/apis/${api.id}/ownership/http-check`, { cookie, body: {} }), ctx(api.id));
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

  it("serves the same challenge file on every download", async () => {
    const a = await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie }), ctx(api.id));
    const b = await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie }), ctx(api.id));
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(a.headers.get("content-disposition")).toBe(`attachment; filename="${api.id}.txt"`);
    const text = await a.text();
    expect(text).toMatch(new RegExp(`^hirakumi-verification=${api.id}\\.`));
    expect(await b.text()).toBe(text);
  });

  it("asks for the file before checking", async () => {
    setGatewayForTests(fakeGateway(async () => ({ ok: true, triedUrl: "x", detail: "y" })));
    const res = await httpCheck(jsonRequest(`/api/apis/${api.id}/ownership/http-check`, { cookie, body: {} }), ctx(api.id));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Download the verification file first/);
  });

  it("passes the gateway's failure through with the URL tried", async () => {
    setGatewayForTests(fakeGateway(async () => ({ ok: false, triedUrl: "https://price.example.dev/.well-known/hirakumi/x.txt", detail: "Got HTTP 404 Not Found." })));
    await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie }), ctx(api.id));
    const res = await httpCheck(jsonRequest(`/api/apis/${api.id}/ownership/http-check`, { cookie, body: {} }), ctx(api.id));
    expect(await res.json()).toEqual({ ok: false, triedUrl: "https://price.example.dev/.well-known/hirakumi/x.txt", detail: "Got HTTP 404 Not Found." });
    expect((await getWalletMessage()).res.status).toBe(409);
  });

  it("answers 502 in plain English when the gateway is unreachable", async () => {
    setGatewayForTests(fakeGateway(async () => {
      throw new GatewayError("We couldn't reach the Hirakumi checker. Try again in a minute.", "ECONNREFUSED");
    }));
    await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie }), ctx(api.id));
    const res = await httpCheck(jsonRequest(`/api/apis/${api.id}/ownership/http-check`, { cookie, body: {} }), ctx(api.id));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "We couldn't reach the Hirakumi checker. Try again in a minute." });
  });

  it("refuses to issue a wallet message before the file check passed", async () => {
    const { res, body } = await getWalletMessage();
    expect(res.status).toBe(409);
    expect(body.error).toBe("Check your verification file first.");
  });

  it("verifies the owner's signature and moves to ownership_verified", async () => {
    await passFileCheck();
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
  });

  it("rejects a signature from a different wallet", async () => {
    await passFileCheck();
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
    await passFileCheck();
    const { body } = await getWalletMessage();
    const signed = { challengeId: body.challengeId, ...wallet.sign(body.message) };
    expect((await sendVerify(signed)).status).toBe(200);
    await getSql()`update apis set state = 'endpoints_confirmed' where id = ${api.id}`;
    expect((await sendVerify(signed)).status).toBe(409);
  });

  it("refuses an expired challenge", async () => {
    await passFileCheck();
    const { body } = await getWalletMessage();
    await getSql()`update challenges set expires_at = now() - interval '1 minute' where id = ${body.challengeId}`;
    const res = await sendVerify({ challengeId: body.challengeId, ...wallet.sign(body.message) });
    expect(res.status).toBe(409);
    expect(await apiState()).toBe("endpoints_confirmed");
  });

  it("returns 404 for another seller's API", async () => {
    const intruder = await seedSeller();
    const res = await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie: cookieFor(intruder) }), ctx(api.id));
    expect(res.status).toBe(404);
  });
});
