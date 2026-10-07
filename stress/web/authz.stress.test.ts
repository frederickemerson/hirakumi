// Every seller route, every way of not being the owner: no cookie, tampered / foreign-secret / expired / unsigned
// sessions, another seller's valid session, and the owner's session sent cross-site. None may change a row.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { setGatewayForTests, type Gateway } from "@/lib/gateway";
import { createSessionToken } from "@/lib/session";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, ctx } from "@/test/requests";
import { POST as createApi } from "@/app/api/apis/route";
import { DELETE as deleteApi } from "@/app/api/apis/[apiId]/route";
import { POST as endpoints } from "@/app/api/apis/[apiId]/endpoints/route";
import { POST as specCheck } from "@/app/api/apis/[apiId]/ownership/spec-check/route";
import { POST as ownVerify } from "@/app/api/apis/[apiId]/ownership/verify/route";
import { POST as walletChallenge } from "@/app/api/apis/[apiId]/ownership/wallet-challenge/route";
import { POST as pricing } from "@/app/api/apis/[apiId]/pricing/route";
import { GET as progress } from "@/app/api/apis/[apiId]/progress/route";
import { POST as phrase } from "@/app/api/apis/[apiId]/promise-phrase/route";
import { POST as publish } from "@/app/api/apis/[apiId]/publish/route";
import { POST as retire } from "@/app/api/apis/[apiId]/retire/route";
import { DELETE as authDelete, POST as authSave } from "@/app/api/apis/[apiId]/upstream-auth/route";
import { GET as chatGet, POST as chatPost } from "@/app/api/chat/route";
import { POST as selfTry } from "@/app/api/apis/[apiId]/try/route";
import { POST as selfFree } from "@/app/api/apis/[apiId]/try/free/route";
import { GET as selfReceipts } from "@/app/api/apis/[apiId]/try/receipts/route";
import { POST as selfPrepare } from "@/app/api/apis/[apiId]/try/pay/prepare/route";
import { POST as selfPay } from "@/app/api/apis/[apiId]/try/pay/route";

type Handler = (req: Request, c: { params: Promise<{ apiId: string }> }) => Promise<Response>;
const ROUTES: { name: string; method: string; h: Handler; body?: unknown }[] = [
  { name: "DELETE api", method: "DELETE", h: deleteApi },
  { name: "endpoints", method: "POST", h: endpoints, body: { operations: [] } },
  { name: "spec-check", method: "POST", h: specCheck, body: {} },
  { name: "ownership verify", method: "POST", h: ownVerify, body: { challengeId: "ch_x", signature: "00", key: "00" } },
  { name: "wallet-challenge", method: "POST", h: walletChallenge, body: {} },
  { name: "pricing", method: "POST", h: pricing, body: { packCalls: "10", packPrice: "1", escrowPrice: "1" } },
  { name: "progress", method: "GET", h: progress },
  { name: "promise-phrase", method: "POST", h: phrase, body: { phrase: "ok" } },
  { name: "publish", method: "POST", h: publish, body: {} },
  { name: "retire", method: "POST", h: retire, body: {} },
  { name: "upstream-auth save", method: "POST", h: authSave, body: { in: "header", name: "X-API-Key", value: "hkfake_0123456789abcdef" } },
  { name: "upstream-auth delete", method: "DELETE", h: authDelete },
  { name: "self-test call", method: "POST", h: selfTry, body: { opId: "getPrice", method: "GET", input: {} } },
  { name: "self-test free", method: "POST", h: selfFree, body: {} },
  { name: "self-test receipts", method: "GET", h: selfReceipts },
  { name: "self-test prepare", method: "POST", h: selfPrepare, body: { utxos: ["00"], changeAddress: "00" } },
  { name: "self-test pay", method: "POST", h: selfPay, body: { tx: "00", witnessSet: "00", nonce: `${"0".repeat(64)}#0`, priceMicros: "1" } },
];

const b64 = (s: string) => Buffer.from(s).toString("base64url");
function forge(payload: object, secret: string): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${createHmac("sha256", secret).update(`session.${body}`).digest("base64url")}`;
}

function req(method: string, apiId: string, o: { cookie?: string; headers?: Record<string, string>; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { ...o.headers };
  if (o.cookie) headers.cookie = o.cookie;
  const hasBody = o.body !== undefined && method !== "GET";
  if (hasBody) headers["content-type"] = "application/json";
  return new Request(`https://web.hirakumi.test/api/apis/${apiId}/x`, { method, headers, body: hasBody ? JSON.stringify(o.body) : undefined });
}

/** Everything a successful seller action would change, for the victim's APIs. */
async function snapshot(): Promise<string> {
  const sql = getSql();
  const apis = await sql`select id, state, deleted_at, upstream_auth, ownership_paused_at from apis order by id`;
  const counts = await sql`select (select count(*) from challenges)::int c, (select count(*) from packs)::int p,
    (select count(*) from operations)::int o, (select count(*) from messages)::int m, (select count(*) from rules)::int r`;
  return JSON.stringify({ apis, counts });
}

describe("authz sweep: every seller route x every non-owner", () => {
  let victim: Seller;
  let attacker: Seller;
  let apis: Api[];
  const reload = vi.fn(async () => undefined);
  const check = vi.fn(async () => ({ ok: true, triedUrl: "https://x" }));

  beforeEach(async () => {
    await resetDb();
    victim = await seedSeller();
    attacker = await seedSeller();
    apis = [
      await seedApi(victim.id, "endpoints_confirmed"),
      await seedApi(victim.id, "priced"),
      await seedApi(victim.id, "live"),
    ];
    reload.mockClear();
    check.mockClear();
    setGatewayForTests({ checkChallenge: check, reloadApi: reload, getHealth: vi.fn(), getSettlement: vi.fn(async () => []) } as unknown as Gateway);
    vi.stubEnv("SESSION_SECRET", "test-session-secret-0123456789abcdef");
  });
  afterEach(() => { setGatewayForTests(null); vi.unstubAllEnvs(); });

  it("no session, tampered, foreign-secret, expired, unsigned and malformed sessions: 401 on every route, nothing changes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = createSessionToken(attacker.id, attacker.cardanoAddr);
    const [body] = valid.split(".");
    const victimBody = b64(JSON.stringify({ sid: victim.id, addr: victim.cardanoAddr, exp: now + 3600 }));
    const cookies: Record<string, string | undefined> = {
      none: undefined,
      tampered: `hk_session=${victimBody}.${valid.split(".")[1]}`,
      foreignSecret: `hk_session=${forge({ sid: victim.id, addr: victim.cardanoAddr, exp: now + 3600 }, "another-secret-0123456789abcdef")}`,
      emptySecret: `hk_session=${forge({ sid: victim.id, addr: victim.cardanoAddr, exp: now + 3600 }, "")}`,
      expired: `hk_session=${createSessionToken(victim.id, victim.cardanoAddr, now - 8 * 24 * 3600)}`,
      expNaN: `hk_session=${forge({ sid: victim.id, addr: victim.cardanoAddr, exp: "9999999999" }, "test-session-secret-0123456789abcdef")}`,
      unsigned: `hk_session=${victimBody}`,
      emptySig: `hk_session=${victimBody}.`,
      threeParts: `hk_session=${victimBody}.${valid.split(".")[1]}.x`,
      loginToken: `hk_session=${body}.${createHmac("sha256", "test-session-secret-0123456789abcdef").update(`login.${body}`).digest("base64url")}`,
      sidNotString: `hk_session=${forge({ sid: { $ne: null }, addr: "x", exp: now + 3600 }, "test-session-secret-0123456789abcdef")}`,
      huge: `hk_session=${"A".repeat(100_000)}.${"B".repeat(43)}`,
      unicode: "hk_session=éé.é",
    };
    const before = await snapshot();
    const out: string[] = [];
    for (const [cname, cookie] of Object.entries(cookies)) {
      for (const r of ROUTES) {
        for (const api of apis) {
          const res = await r.h(req(r.method, api.id, { cookie, body: r.body }), ctx(api.id));
          if (res.status !== 401) out.push(`${cname} ${r.name} ${api.state} -> ${res.status}`);
        }
      }
      for (const [n, h] of [["chat GET", chatGet], ["chat POST", chatPost], ["create", createApi]] as const) {
        const res = await (h as (r: Request) => Promise<Response>)(req(n === "chat GET" ? "GET" : "POST", "none", {
          cookie, body: n === "create" ? { openapiUrl: "https://victim.example/openapi.json" } : { body: "hi" },
        }));
        if (res.status !== 401) out.push(`${cname} ${n} -> ${res.status}`);
      }
    }
    expect(out).toEqual([]);
    expect(await snapshot()).toBe(before);
    expect(reload).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("another seller's valid session: 404 on every route for every victim API, nothing changes", async () => {
    const before = await snapshot();
    const out: string[] = [];
    for (const r of ROUTES) for (const api of apis) {
      const res = await r.h(req(r.method, api.id, { cookie: cookieFor(attacker), body: r.body }), ctx(api.id));
      if (res.status !== 404) out.push(`${r.name} ${api.state} -> ${res.status}`);
    }
    const chat = await chatPost(req("POST", "x", { cookie: cookieFor(attacker), body: { body: "hi", apiId: apis[2].id } }));
    if (chat.status !== 404) out.push(`chat POST -> ${chat.status}`);
    const chatRead = await chatGet(new Request(`https://web.hirakumi.test/api/chat?apiId=${apis[2].id}`, { headers: { cookie: cookieFor(attacker) } }));
    if (chatRead.status !== 404) out.push(`chat GET -> ${chatRead.status}`);
    expect(out).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it("the owner's own valid session sent cross-site (Sec-Fetch-Site, foreign / null / malformed Origin): 403, nothing changes", async () => {
    const variants: Record<string, Record<string, string>> = {
      crossSite: { "sec-fetch-site": "cross-site" },
      sameSite: { "sec-fetch-site": "same-site" }, // a sibling subdomain is another site's code
      foreignOrigin: { origin: "https://evil.example" },
      nullOrigin: { origin: "null" },
      malformedOrigin: { origin: "::::" },
      lookalike: { origin: "https://web.hirakumi.test.evil.example" },
      httpDowngrade: { origin: "http://web.hirakumi.test" },
      otherPort: { origin: "https://web.hirakumi.test:8443" },
      fetchSiteBeatsOrigin: { "sec-fetch-site": "cross-site", origin: "https://web.hirakumi.test" },
    };
    const before = await snapshot();
    const out: string[] = [];
    for (const [vname, headers] of Object.entries(variants)) {
      for (const r of ROUTES.filter((x) => x.method !== "GET")) for (const api of apis) {
        const res = await r.h(req(r.method, api.id, { cookie: cookieFor(victim), headers, body: r.body }), ctx(api.id));
        if (res.status !== 403) out.push(`${vname} ${r.name} ${api.state} -> ${res.status}`);
      }
      const c = await createApi(req("POST", "x", { cookie: cookieFor(victim), headers, body: { openapiUrl: "https://victim.example/openapi.json" } }));
      if (c.status !== 403) out.push(`${vname} create -> ${c.status}`);
      const m = await chatPost(req("POST", "x", { cookie: cookieFor(victim), headers, body: { body: "hi" } }));
      if (m.status !== 403) out.push(`${vname} chat -> ${m.status}`);
    }
    expect(out).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it("a cross-site form post (text/plain or form-encoded body) to create cannot create an API", async () => {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain; application/json", "application/json5", "application/jsonx"]) {
      const res = await createApi(new Request("https://web.hirakumi.test/api/apis", {
        method: "POST", headers: { cookie: cookieFor(victim), "content-type": ct }, body: JSON.stringify({ openapiUrl: "https://victim.example/openapi.json" }),
      }));
      expect(res.status, ct).toBe(400);
    }
    expect((await getSql()`select count(*)::int n from apis where seller_id = ${victim.id}`)[0].n).toBe(3);
  });

  it("an API id that is SQL-ish, huge, unicode or a path never answers anything but 404 to its owner", async () => {
    const ids = ["' or 1=1 --", "api_x%00", "../../etc/passwd", "a".repeat(10_000), "‮\u0000", apis[0].id.toUpperCase(), ` ${apis[0].id}`];
    for (const id of ids) for (const r of ROUTES) {
      const res = await r.h(req(r.method, "x", { cookie: cookieFor(victim), body: r.body }), ctx(id));
      expect(res.status, `${r.name} ${JSON.stringify(id.slice(0, 20))}`).toBe(404);
    }
  });

  it("a deleted API is gone for its owner too: every route answers 404 once DELETE succeeded", async () => {
    const api = apis[0];
    expect((await deleteApi(req("DELETE", api.id, { cookie: cookieFor(victim) }), ctx(api.id))).status).toBe(200);
    for (const r of ROUTES) {
      const res = await r.h(req(r.method, api.id, { cookie: cookieFor(victim), body: r.body }), ctx(api.id));
      expect(res.status, r.name).toBe(404);
    }
    // A live API that sold is hidden, not erased: also 404 to its owner afterwards.
    const live = apis[2];
    expect((await deleteApi(req("DELETE", live.id, { cookie: cookieFor(victim) }), ctx(live.id))).status).toBe(200);
    for (const r of ROUTES) {
      const res = await r.h(req(r.method, live.id, { cookie: cookieFor(victim), body: r.body }), ctx(live.id));
      expect(res.status, r.name).toBe(404);
    }
  });
});
