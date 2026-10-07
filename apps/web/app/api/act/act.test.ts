import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateUpstreamAuthKeys, hashActToken, newActToken, newId, type ActAction } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { setExposureFetchForTests } from "@/lib/exposure";
import { setGatewayForTests, type ChallengeCheck, type Gateway } from "@/lib/gateway";
import { getOrCreateVerifyCode, markVerifyPassed } from "@/lib/repo/challenges";
import { getUpstreamAuth } from "@/lib/repo/upstream-auth";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedPack, seedRule, seedSeller } from "@/test/factories";
import { jsonRequest } from "@/test/requests";
import { makeTestWallet, type TestWallet } from "@/test/wallet-fixture";
import { POST as challengeRoute } from "./[token]/challenge/route";
import { POST as actRoute } from "./[token]/route";

/**
 * The one-time links of a Sokosumi task (/act/<token>). The token only selects the API and the action; every action
 * needs the API owner's wallet signature, so a leaked link does nothing on its own.
 */
const keys = generateUpstreamAuthKeys();
const PASS: ChallengeCheck = { ok: true, reason: "verified", record: "_hirakumi.price.example.dev", detail: "found" };
const MISSING: ChallengeCheck = { ok: false, reason: "missing", record: "_hirakumi.price.example.dev", detail: "no record" };

let wallet: TestWallet;
let seller: Seller;
let checkChallenge: ReturnType<typeof vi.fn>;

const tctx = (token: string) => ({ params: Promise.resolve({ token }) });

async function makeLink(apiId: string, action: ActAction, o: { expired?: boolean; used?: boolean } = {}): Promise<string> {
  const token = newActToken();
  await getSql()`
    insert into act_tokens (id, token_hash, api_id, action, wallet, expires_at, used_at)
    values (${newId("act")}, ${hashActToken(token)}, ${apiId}, ${action}, ${seller.cardanoAddr},
            ${o.expired ? getSql()`now() - interval '1 minute'` : getSql()`now() + interval '30 minutes'`},
            ${o.used ? getSql()`now()` : null})`;
  return token;
}

async function askChallenge(token: string, address: string) {
  const res = await challengeRoute(jsonRequest(`/api/act/${token}/challenge`, { body: { address } }), tctx(token));
  return { res, body: (await res.json()) as { kind?: string; challengeId?: string; nonceToken?: string; message?: string; error?: string } };
}

async function send(token: string, body: Record<string, unknown>) {
  const res = await actRoute(jsonRequest(`/api/act/${token}`, { body }), tctx(token));
  return { res, body: (await res.json()) as { done?: boolean; message?: string; error?: string; code?: string } };
}

/** The whole page flow: ask for the message, sign it with `signer`, send it. */
async function signAndSend(token: string, signer: TestWallet = wallet, extra: Record<string, unknown> = {}) {
  const ch = await askChallenge(token, signer.addressHex);
  if (ch.res.status !== 200) return { res: ch.res, body: ch.body };
  const handle = ch.body.kind === "wallet" ? { challengeId: ch.body.challengeId } : { nonceToken: ch.body.nonceToken };
  return send(token, { address: signer.addressHex, ...signer.sign(ch.body.message!), ...handle, ...extra });
}

async function apiRow(id: string) {
  const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${id}`;
  return row.state;
}
async function linkUsed(token: string) {
  const [row] = await getSql()<{ used: boolean }[]>`select used_at is not null as used from act_tokens where token_hash = ${hashActToken(token)}`;
  return row.used;
}

async function pricedApi(): Promise<Api> {
  const api = await seedApi(seller.id, "priced", { sokosumiTaskId: `tsk_${newId("ch")}` });
  const op = await seedOperation(api.id, { enabled: true });
  await seedRule(op.id);
  await seedPack(api.id, { calls: 100, priceMicros: "2000000" });
  return api;
}

describe("/act one-time links", () => {
  beforeEach(async () => {
    await resetDb();
    wallet = await makeTestWallet();
    seller = await seedSeller(wallet.bech32);
    checkChallenge = vi.fn(async () => PASS);
    setGatewayForTests({ checkChallenge, reloadApi: vi.fn(async () => undefined), getHealth: vi.fn(), getSettlement: vi.fn(async () => []) } as unknown as Gateway);
    // The leak check: a call without the key is refused, so the API is protected.
    setExposureFetchForTests(async () => ({ status: 401, contentType: "application/json", body: "{}", latencyMs: 1 }));
    vi.stubEnv("UPSTREAM_AUTH_PUBLIC_KEY", keys.publicKey);
  });
  afterEach(() => {
    setGatewayForTests(null);
    setExposureFetchForTests(null);
    vi.unstubAllEnvs();
  });

  describe("which links can act", () => {
    it("an unknown, malformed, expired or used link does nothing", async () => {
      const api = await seedApi(seller.id, "endpoints_confirmed");
      const expired = await makeLink(api.id, "ownership", { expired: true });
      const used = await makeLink(api.id, "ownership", { used: true });
      expect((await askChallenge(newActToken(), wallet.addressHex)).res.status).toBe(404);
      expect((await askChallenge("not-a-token", wallet.addressHex)).res.status).toBe(404);
      const e = await askChallenge(expired, wallet.addressHex);
      expect(e.res.status).toBe(410);
      expect(e.body.error).toMatch(/expired/);
      const u = await askChallenge(used, wallet.addressHex);
      expect(u.res.status).toBe(410);
      expect(u.body.error).toMatch(/already used/);
      expect((await send(expired, { address: wallet.addressHex, signature: "00", key: "00", challengeId: "ch_x" })).res.status).toBe(410);
    });

    it("refuses another wallet before anything is issued, naming the wallet the link is for", async () => {
      const api = await seedApi(seller.id, "endpoints_confirmed");
      const token = await makeLink(api.id, "ownership");
      const other = await makeTestWallet();
      const { res, body } = await askChallenge(token, other.addressHex);
      expect(res.status).toBe(403);
      expect(body.error).toBe(`This link is for the wallet ending …${wallet.bech32.slice(-6)}. Switch to that wallet and sign again.`);
      const issued = await getSql()`select 1 from challenges where api_id = ${api.id} and kind = 'wallet'`;
      expect(issued).toHaveLength(0);
      expect(checkChallenge).not.toHaveBeenCalled();
    });

    it("a link for a step the API is not at does nothing (wrong action for the state)", async () => {
      const api = await pricedApi();
      const own = await makeLink(api.id, "ownership");
      const { res, body } = await askChallenge(own, wallet.addressHex);
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/isn't at any more \(it is at: Ready to publish\)/);
      const early = await seedApi(seller.id, "endpoints_confirmed");
      expect((await askChallenge(await makeLink(early.id, "publish"), wallet.addressHex)).res.status).toBe(409);
    });

    it("refuses a cross-site request", async () => {
      const api = await seedApi(seller.id, "endpoints_confirmed");
      const token = await makeLink(api.id, "ownership");
      const req = new Request(`https://web.hirakumi.test/api/act/${token}/challenge`, {
        method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ address: wallet.addressHex }),
      });
      expect((await challengeRoute(req, tctx(token))).status).toBe(403);
    });
  });

  describe("ownership", () => {
    it("the owner signs once: ownership is proven, the code consumed, the link used up and useless afterwards", async () => {
      const api = await seedApi(seller.id, "endpoints_confirmed", { sokosumiTaskId: "tsk_own" });
      const code = await getOrCreateVerifyCode(getSql(), api.id);
      await markVerifyPassed(getSql(), code.id, PASS.record);
      const token = await makeLink(api.id, "ownership");
      const ch = await askChallenge(token, wallet.addressHex);
      expect(ch.body.kind).toBe("wallet");
      expect(ch.body.message).toContain(api.id);
      expect(ch.body.message).toContain(wallet.bech32);
      expect(checkChallenge).not.toHaveBeenCalled(); // the coworker's pass is fresh
      const { res, body } = await send(token, { address: wallet.addressHex, ...wallet.sign(ch.body.message!), challengeId: ch.body.challengeId });
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ done: true, message: "Done. You can close this tab; the rest continues in Sokosumi." });
      expect(await apiRow(api.id)).toBe("ownership_verified");
      expect(await linkUsed(token)).toBe(true);
      const [proof] = await getSql()<{ signature: string | null }[]>`select proof->>'signature' as signature from challenges where id = ${ch.body.challengeId!}`;
      expect(proof.signature).toBeTruthy();
      expect((await signAndSend(token)).res.status).toBe(410);
    });

    it("looks the DNS record up again when the last pass is older than 30 minutes, and refuses while it is missing", async () => {
      const api = await seedApi(seller.id, "endpoints_confirmed");
      await getOrCreateVerifyCode(getSql(), api.id);
      const token = await makeLink(api.id, "ownership");
      checkChallenge.mockResolvedValueOnce(MISSING);
      const missing = await askChallenge(token, wallet.addressHex);
      expect(missing.res.status).toBe(409);
      expect(missing.body.error).toMatch(/can't find your DNS record at _hirakumi\.price\.example\.dev/);
      const { res } = await signAndSend(token);
      expect(res.status).toBe(200);
      expect(checkChallenge).toHaveBeenCalledTimes(2);
      expect(await apiRow(api.id)).toBe("ownership_verified");
    });

    it("a signature by another wallet over the owner's message is refused, and the link still works for the owner", async () => {
      const api = await seedApi(seller.id, "endpoints_confirmed");
      const token = await makeLink(api.id, "ownership");
      const ch = await askChallenge(token, wallet.addressHex);
      const other = await makeTestWallet();
      // Claims the owner's address, signs with another key.
      const forged = await send(token, { address: wallet.addressHex, ...other.sign(ch.body.message!), challengeId: ch.body.challengeId });
      expect(forged.res.status).toBe(401);
      // Says who it is: refused as the wrong wallet.
      const wrong = await send(token, { address: other.addressHex, ...other.sign(ch.body.message!), challengeId: ch.body.challengeId });
      expect(wrong.res.status).toBe(403);
      expect(await apiRow(api.id)).toBe("endpoints_confirmed");
      expect(await linkUsed(token)).toBe(false);
      expect((await send(token, { address: wallet.addressHex, ...wallet.sign(ch.body.message!), challengeId: ch.body.challengeId })).res.status).toBe(200);
    });

    it("saves the API's key with the signature, sealed for the gateway, before ownership is final", async () => {
      const api = await seedApi(seller.id, "endpoints_confirmed");
      const token = await makeLink(api.id, "ownership");
      const { res } = await signAndSend(token, wallet, { upstreamAuth: { in: "header", name: "X-API-Key", value: "sk_live_0123456789abcdefWXYZ" } });
      expect(res.status).toBe(200);
      expect(await getUpstreamAuth(getSql(), api.id)).toEqual({ in: "header", name: "X-API-Key", hint: "WXYZ" });
      const [row] = await getSql()<{ raw: string }[]>`select upstream_auth::text as raw from apis where id = ${api.id}`;
      expect(row.raw).not.toContain("sk_live_0123456789abcdef");
    });

    it("a nonce token (key or publish message) is not an ownership signature", async () => {
      const api = await seedApi(seller.id, "endpoints_confirmed");
      const token = await makeLink(api.id, "ownership");
      const { res } = await send(token, { address: wallet.addressHex, signature: "00", key: "00", nonceToken: "x.y" });
      expect(res.status).toBe(400);
    });
  });

  describe("publish", () => {
    it("the owner signs the price: published (registering), the link used up", async () => {
      const api = await pricedApi();
      const token = await makeLink(api.id, "publish");
      const ch = await askChallenge(token, wallet.addressHex);
      expect(ch.body.kind).toBe("act");
      expect(ch.body.message).toMatch(/^Sign to publish price\.example\.dev at 2 tUSDM for 100 calls\nAPI: api_/);
      const { res, body } = await send(token, { address: wallet.addressHex, ...wallet.sign(ch.body.message!), nonceToken: ch.body.nonceToken });
      expect(res.status).toBe(200);
      expect(body.done).toBe(true);
      expect(await apiRow(api.id)).toBe("registering");
      expect(await linkUsed(token)).toBe(true);
      // The signed message can't be sent again, on this link or another.
      const again = await send(token, { address: wallet.addressHex, ...wallet.sign(ch.body.message!), nonceToken: ch.body.nonceToken });
      expect(again.res.status).toBe(410);
    });

    it("a signature for one link is refused on another (wrong action or wrong API), and a reused nonce is refused", async () => {
      const api = await pricedApi();
      const keyLink = await makeLink(api.id, "key");
      const publishLink = await makeLink(api.id, "publish");
      const keyCh = await askChallenge(keyLink, wallet.addressHex);
      const onPublish = await send(publishLink, { address: wallet.addressHex, ...wallet.sign(keyCh.body.message!), nonceToken: keyCh.body.nonceToken });
      expect(onPublish.res.status).toBe(400);
      expect(await apiRow(api.id)).toBe("priced");
      // An ownership challenge id is not a publish signature either.
      expect((await send(publishLink, { address: wallet.addressHex, signature: "00", key: "00", challengeId: "ch_x" })).res.status).toBe(400);
      // A nonce used once (a refused key save consumed it) can't be replayed.
      const ch = await askChallenge(publishLink, wallet.addressHex);
      const signed = { address: wallet.addressHex, ...wallet.sign(ch.body.message!), nonceToken: ch.body.nonceToken };
      await getSql()`insert into used_login_nonces (nonce, expires_at) select ${JSON.parse(Buffer.from(ch.body.nonceToken!.split(".")[0], "base64url").toString()).nonce}, now() + interval '5 minutes'`;
      expect((await send(publishLink, signed)).res.status).toBe(401);
      expect(await linkUsed(publishLink)).toBe(false);
    });

    it("a price changed after signing is signed again", async () => {
      const api = await pricedApi();
      const token = await makeLink(api.id, "publish");
      const ch = await askChallenge(token, wallet.addressHex);
      await getSql()`update packs set price_micros = 5000000 where api_id = ${api.id}`;
      const { res, body } = await send(token, { address: wallet.addressHex, ...wallet.sign(ch.body.message!), nonceToken: ch.body.nonceToken });
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/changed since you signed/);
      expect(await apiRow(api.id)).toBe("priced");
    });

    it("the leak check still decides: an API anyone can call is not published, and the link stays usable", async () => {
      const api = await pricedApi();
      setExposureFetchForTests(async () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ price: 1, last_updated: new Date().toISOString() }), latencyMs: 1 }));
      const token = await makeLink(api.id, "publish");
      const { res, body } = await signAndSend(token);
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/^Anyone can call this API for free/);
      expect(await apiRow(api.id)).toBe("priced");
      expect(await linkUsed(token)).toBe(false);
    });
  });

  describe("key", () => {
    it("saves the key at any later step and tells the task; a signature without a key saves nothing", async () => {
      const api = await seedApi(seller.id, "rule_built", { sokosumiTaskId: "tsk_key" });
      const token = await makeLink(api.id, "key");
      const missing = await signAndSend(token);
      expect(missing.res.status).toBe(400);
      const { res } = await signAndSend(token, wallet, { upstreamAuth: { in: "query", name: "api_key", value: "abcd1234efgh5678" } });
      expect(res.status).toBe(200);
      expect(await getUpstreamAuth(getSql(), api.id)).toEqual({ in: "query", name: "api_key", hint: "5678" });
      expect(await linkUsed(token)).toBe(true);
      const msgs = await getSql()<{ body: string; taskId: string }[]>`select body, task_id from messages where api_id = ${api.id}`;
      expect(msgs).toEqual([{ body: "Your API's key is saved, sealed so only the Hirakumi gateway can read it.", taskId: "tsk_key" }]);
    });
  });
});
