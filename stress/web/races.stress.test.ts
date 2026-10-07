// Concurrency on the seller flows: double submits, one-listing races between accounts, wallet-challenge replay,
// delete racing delete / publish / key saving, and sign-in replay.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateUpstreamAuthKeys } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { setGatewayForTests, type Gateway } from "@/lib/gateway";
import { getOrCreateVerifyCode, markVerifyPassed } from "@/lib/repo/challenges";
import type { Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedPack, seedRule, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { makeTestWallet, type TestWallet } from "@/test/wallet-fixture";
import { POST as createApi } from "@/app/api/apis/route";
import { DELETE as deleteApi } from "@/app/api/apis/[apiId]/route";
import { POST as verify } from "@/app/api/apis/[apiId]/ownership/verify/route";
import { POST as walletChallenge } from "@/app/api/apis/[apiId]/ownership/wallet-challenge/route";
import { POST as publish } from "@/app/api/apis/[apiId]/publish/route";
import { POST as retire } from "@/app/api/apis/[apiId]/retire/route";
import { POST as authSave } from "@/app/api/apis/[apiId]/upstream-auth/route";
import { POST as nonce } from "@/app/api/auth/nonce/route";
import { POST as login } from "@/app/api/auth/verify/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";

const tally = <T extends string | number>(xs: T[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const reload = vi.fn(async () => undefined);
const gateway = { checkChallenge: vi.fn(), reloadApi: reload, getHealth: vi.fn(), getSettlement: vi.fn(async () => []) } as unknown as Gateway;

beforeEach(async () => {
  await resetDb();
  reload.mockClear();
  setGatewayForTests(gateway);
});
afterEach(() => { setGatewayForTests(null); vi.unstubAllEnvs(); });

describe("double submits", () => {
  it("60 concurrent submits of one OpenAPI link by one seller make exactly one API", async () => {
    const s = await seedSeller();
    const res = await Promise.all(Array.from({ length: 60 }, () =>
      createApi(jsonRequest("/api/apis", { cookie: cookieFor(s), body: { openapiUrl: "https://dup.example/openapi.json" } }))));
    const bodies = await Promise.all(res.map((r) => r.json() as Promise<{ apiId: string; created: boolean }>));
    expect(tally(res.map((r) => r.status))).toEqual({ 200: 59, 201: 1 });
    expect(new Set(bodies.map((b) => b.apiId)).size).toBe(1);
    expect((await getSql()`select count(*)::int n from apis where seller_id = ${s.id}`)[0].n).toBe(1);
  });

  it("40 concurrent example-request submits on one base (some corrected) leave one API on that base", async () => {
    const s = await seedSeller();
    const res = await Promise.all(Array.from({ length: 40 }, (_, i) => createApi(jsonRequest("/api/apis", {
      cookie: cookieFor(s), body: { mode: "samples", baseUrl: "https://samples.example/v1", samples: `GET /price?symbol=A${i % 4}DA` },
    }))));
    expect(res.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const rows = await getSql()`select id from apis where seller_id = ${s.id} and deleted_at is null`;
    expect(rows).toHaveLength(1);
  });
});

describe("ownership proof races", () => {
  let wallets: TestWallet[];
  beforeAll(async () => { wallets = [await makeTestWallet(0), await makeTestWallet(0)]; });

  async function ready(wallet: TestWallet, origin: string, pathPrefix: string) {
    const seller = await seedSeller(wallet.bech32);
    const api = await seedApi(seller.id, "endpoints_confirmed", { origin, pathPrefix });
    const code = await getOrCreateVerifyCode(getSql(), api.id);
    await markVerifyPassed(getSql(), code.id, `${origin}${pathPrefix}`);
    const res = await walletChallenge(jsonRequest(`/x`, { cookie: cookieFor(seller), body: {} }), ctx(api.id));
    expect(res.status).toBe(200);
    const { challengeId, message } = (await res.json()) as { challengeId: string; message: string };
    return { seller, api, challengeId, signed: wallet.sign(message) };
  }

  it("one signed wallet challenge sent 30 times at once: exactly one proof, the rest 409", async () => {
    const r = await ready(wallets[0], "https://own.example", "/v1");
    const res = await Promise.all(Array.from({ length: 30 }, () =>
      verify(jsonRequest(`/x`, { cookie: cookieFor(r.seller), body: { challengeId: r.challengeId, ...r.signed } }), ctx(r.api.id))));
    expect(tally(res.map((x) => x.status))).toEqual({ 200: 1, 409: 29 });
    const [row] = await getSql()`select state from apis where id = ${r.api.id}`;
    expect(row.state).toBe("ownership_verified");
  });

  it("two accounts proving the same base at the same moment: exactly one listing wins", async () => {
    const a = await ready(wallets[0], "https://contested.example", "/api");
    const b = await ready(wallets[1], "https://contested.example", "/api");
    const send = (r: typeof a) => verify(jsonRequest(`/x`, { cookie: cookieFor(r.seller), body: { challengeId: r.challengeId, ...r.signed } }), ctx(r.api.id));
    const res = await Promise.all([send(a), send(b), send(a), send(b)]);
    expect(res.filter((x) => x.status === 200)).toHaveLength(1);
    const states = await getSql()`select state from apis where id in ${getSql()([a.api.id, b.api.id])}`;
    expect(states.filter((s) => s.state === "ownership_verified")).toHaveLength(1);
  });

  it("a challenge signed for API A cannot prove API B of the same seller, nor be used by another seller", async () => {
    const a = await ready(wallets[0], "https://cross.example", "/a");
    const other = await seedApi(a.seller.id, "endpoints_confirmed", { origin: "https://cross.example", pathPrefix: "/b" });
    const code = await getOrCreateVerifyCode(getSql(), other.id);
    await markVerifyPassed(getSql(), code.id, "https://cross.example/b");
    const onB = await verify(jsonRequest(`/x`, { cookie: cookieFor(a.seller), body: { challengeId: a.challengeId, ...a.signed } }), ctx(other.id));
    expect(onB.status).toBe(409);
    const mallory = await seedSeller();
    const asMallory = await verify(jsonRequest(`/x`, { cookie: cookieFor(mallory), body: { challengeId: a.challengeId, ...a.signed } }), ctx(a.api.id));
    expect(asMallory.status).toBe(404);
    const [row] = await getSql()`select state from apis where id = ${other.id}`;
    expect(row.state).toBe("endpoints_confirmed");
  });
});

describe("delete races", () => {
  let s: Seller;
  beforeEach(async () => { s = await seedSeller(); });
  const del = (id: string) => deleteApi(jsonRequest(`/x`, { cookie: cookieFor(s), method: "DELETE" }), ctx(id));

  it("20 concurrent deletes of one API: one 200, nineteen 404, no orphan rows", async () => {
    const api = await seedApi(s.id, "rule_built");
    const op = await seedOperation(api.id);
    await seedRule(op.id);
    await seedPack(api.id);
    const res = await Promise.all(Array.from({ length: 20 }, () => del(api.id)));
    expect(tally(res.map((r) => r.status))).toEqual({ 200: 1, 404: 19 });
    const sql = getSql();
    const left = await sql`select (select count(*) from apis where id = ${api.id})::int a, (select count(*) from operations where api_id = ${api.id})::int o,
      (select count(*) from packs where api_id = ${api.id})::int p`;
    expect(left[0]).toEqual({ a: 0, o: 0, p: 0 });
  });

  it("delete racing publish (x20 each): the API ends hidden, never visible and never registering", async () => {
    for (let i = 0; i < 10; i++) {
      const api = await seedApi(s.id, "priced");
      const op = await seedOperation(api.id, { enabled: true });
      await seedRule(op.id);
      await seedPack(api.id);
      const jobs = Array.from({ length: 20 }, (_, k) => (k % 2
        ? del(api.id)
        : publish(jsonRequest(`/x`, { cookie: cookieFor(s), body: {} }), ctx(api.id))));
      await Promise.all(jobs);
      const [row] = await getSql()`select state, deleted_at from apis where id = ${api.id}`;
      if (row) {
        expect(row.deletedAt).toBeInstanceOf(Date);
        expect(row.state).toBe("retired");
      }
    }
  });

  it("delete racing retire and key saves: no key survives on a deleted API", async () => {
    const keys = generateUpstreamAuthKeys();
    vi.stubEnv("UPSTREAM_AUTH_PUBLIC_KEY", keys.publicKey);
    for (let i = 0; i < 10; i++) {
      const api = await seedApi(s.id, "live");
      const jobs = Array.from({ length: 15 }, (_, k) => (k % 3 === 0
        ? del(api.id)
        : k % 3 === 1
          ? retire(jsonRequest(`/x`, { cookie: cookieFor(s), body: {} }), ctx(api.id))
          : authSave(jsonRequest(`/x`, { cookie: cookieFor(s), body: { in: "header", name: "X-API-Key", value: `hkfake_${k}_0123456789abcdef` } }), ctx(api.id))));
      const res = await Promise.all(jobs);
      expect(res.every((r) => r.status < 500)).toBe(true);
      const [row] = await getSql()`select deleted_at, upstream_auth from apis where id = ${api.id}`;
      expect(row.deletedAt).toBeInstanceOf(Date);
      expect(row.upstreamAuth).toBeNull();
    }
  });
});

describe("sign-in", () => {
  async function signIn(wallet: TestWallet) {
    const n = await nonce(jsonRequest("/api/auth/nonce", { body: { address: wallet.bech32 } }));
    const { message, nonceToken } = (await n.json()) as { message: string; nonceToken: string };
    return { nonceToken, ...wallet.sign(message) };
  }

  it("a sign-in for wallet A signed by wallet B, or with the message's nonce token swapped, is refused", async () => {
    const [a, b] = [await makeTestWallet(0), await makeTestWallet(0)];
    const forA = await signIn(a);
    const forB = await signIn(b);
    const mixes = [
      { nonceToken: forA.nonceToken, signature: forB.signature, key: forB.key },
      { nonceToken: forB.nonceToken, signature: forA.signature, key: forA.key },
      { nonceToken: `${forA.nonceToken}x`, signature: forA.signature, key: forA.key },
    ];
    for (const m of mixes) expect((await login(jsonRequest("/api/auth/verify", { body: m }))).status).toBe(401);
  });

  // Fixed: the verify route records the nonce in used_login_nonces (primary key) in the transaction that opens the session.
  it("a signed sign-in can be used once: 20 concurrent replays open one session", async () => {
    const w = await makeTestWallet(0);
    const m = await signIn(w);
    const res = await Promise.all(Array.from({ length: 20 }, () => login(jsonRequest("/api/auth/verify", { body: m }))));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 401)).toHaveLength(19);
  });

  it("concurrent sign-ins of one new wallet create exactly one seller", async () => {
    const w = await makeTestWallet(0);
    const ms = await Promise.all(Array.from({ length: 20 }, () => signIn(w)));
    const res = await Promise.all(ms.map((m) => login(jsonRequest("/api/auth/verify", { body: m }))));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const ids = new Set(await Promise.all(res.map(async (r) => ((await r.json()) as { sellerId: string }).sellerId)));
    expect(ids.size).toBe(1);
    expect((await getSql()`select count(*)::int n from sellers where cardano_addr = ${w.bech32}`)[0].n).toBe(1);
  });

  // Fixed: each session has an id (jti); logout records it in revoked_sessions and every session check looks it up.
  it("after logout, the old session cookie no longer signs anyone in", async () => {
    const s = await seedSeller();
    const cookie = cookieFor(s);
    expect((await logout(new Request("https://web.hirakumi.test/api/auth/logout", { method: "POST", headers: { cookie } }))).status).toBe(303);
    const after = await me(new Request("https://web.hirakumi.test/api/auth/me", { headers: { cookie } }));
    expect(((await after.json()) as { signedIn: boolean }).signedIn).toBe(false);
  });
});
