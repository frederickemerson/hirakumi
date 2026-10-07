import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { generateUpstreamAuthKeys, sealUpstreamSecret } from "@hirakumi/core";
import { createApp } from "../src/app";
import { checkRouted, DomainRegistry, tlsAskDecision, type AddressResolver } from "../src/domains";
import { tlsAskApp } from "../src/frontDoorAdmin";
import { isNativeHost } from "../src/frontDoor";
import { Monitor } from "../src/monitor";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

const HOST = "api.seller.test";
const AUTH = { authorization: "Bearer internal-test-token-0123456789" };

/** A, AAAA and CNAME records by name; `fail` makes every lookup of a name throw with that code. */
export class FakeResolver implements AddressResolver {
  private readonly zone = new Map<string, { a?: string[]; aaaa?: string[]; cname?: string; fail?: string }>();
  set(name: string, r: { a?: string[]; aaaa?: string[]; cname?: string; fail?: string }): void { this.zone.set(name, r); }
  private get(name: string, pick: (r: { a?: string[]; aaaa?: string[]; cname?: string }) => string[] | undefined): Promise<string[]> {
    const r = this.zone.get(name);
    if (r?.fail) return Promise.reject(Object.assign(new Error(r.fail), { code: r.fail }));
    const v = r ? pick(r) : undefined;
    if (!v || v.length === 0) return Promise.reject(Object.assign(new Error("ENODATA"), { code: r ? "ENODATA" : "ENOTFOUND" }));
    return Promise.resolve(v);
  }
  resolve4 = (n: string) => this.get(n, (r) => r.a);
  resolve6 = (n: string) => this.get(n, (r) => r.aaaa);
  resolveCname = (n: string) => this.get(n, (r) => (r.cname ? [r.cname] : undefined));
}

let h: Harness;
let domains: DomainRegistry;
let resolver: FakeResolver;
let app: Express;

async function attachDomain(status = "active", txt = true) {
  await h.sql`insert into api_domains (host, seller_id, status, txt_verified_at) values (${HOST}, ${h.seeded.sellerId}, ${status}, ${txt ? new Date() : null})`;
  await h.sql`update apis set public_host = ${HOST} where id = ${h.seeded.apiId}`;
  domains.invalidate(HOST);
}

beforeEach(async () => {
  h = await makeHarness();
  domains = new DomainRegistry(h.sql);
  resolver = new FakeResolver();
  app = createApp({
    ...h.deps, domains, addressResolver: resolver,
    frontDoorProbe: async (host, path) => {
      const r = await request(app).get(path).set("host", host);
      return { status: r.status, apiId: (r.headers["x-hirakumi-api"] as string | undefined) ?? null };
    },
  });
  await h.sql`
    insert into challenges (id, api_id, kind, token, expires_at, consumed_at, proof)
    values ('ch_fd', ${h.seeded.apiId}, 'dns', 'hkv_code', now() + interval '1 year', now(), ${h.sql.json({ passedAt: new Date().toISOString() })})`;
});
afterEach(async () => { await h.close(); });

const call = (path = "/price?symbol=ADA") => request(app).get(path).set("host", HOST);

describe("hosts", () => {
  it("treats the public host, IPs, single labels and no Host as Hirakumi's own", () => {
    expect(isNativeHost(null, "gw.test")).toBe(true);
    expect(isNativeHost("gateway", "gw.test")).toBe(true);
    expect(isNativeHost("gw.test", "gw.test")).toBe(true);
    expect(isNativeHost(HOST, "gw.test")).toBe(false);
  });
});

describe("the front door", () => {
  beforeEach(async () => { await attachDomain(); });

  it("answers a caller without a pack with the 402 that says it is only available through Hirakumi", async () => {
    const r = await call();
    expect(r.status).toBe(402);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers.link).toBe(`<https://web.test/p/${h.seeded.apiId}>; rel="payment"`);
    expect(r.headers["x-hirakumi-api"]).toBe(h.seeded.apiId);
    const buyUrl = `https://gw.test/a/${h.seeded.apiId}/packs/${h.seeded.packId}`;
    expect(r.body).toMatchObject({
      error: "credits_required",
      message: `This API is only available through Hirakumi. Buy a pack of calls: ${buyUrl}`,
      listingUrl: `https://web.test/p/${h.seeded.apiId}`,
      gatewayUrl: `https://gw.test/a/${h.seeded.apiId}/x/getPrice`,
      packs: [{ packId: h.seeded.packId, buyUrl }],
      ruleHash: h.seeded.ruleHash,
    });
    expect(h.stub.hits()).toBe(0);
  });

  it("builds no URL from the Host header", async () => {
    const r = await call().set("x-forwarded-host", "evil.test");
    expect(JSON.stringify(r.body)).not.toContain("evil");
    expect(JSON.stringify(r.body)).not.toContain(HOST);
  });

  it("gives the 402 to a caller with the seller's old key (a Bearer that isn't a pack token)", async () => {
    const r = await call().set("authorization", "Bearer sk_live_old_key");
    expect(r.status).toBe(402);
    expect(r.body.message).toMatch(/only available through Hirakumi/);
  });

  it("sells the call to a pack token: 200, one credit used, the seller's answer", async () => {
    const t = await insertActiveToken(h.sql, h.seeded);
    const r = await call().set("authorization", `Bearer ${t.token}`);
    expect(r.status).toBe(200);
    expect(r.body.symbol).toBe("ADA");
    expect(r.headers["x-credits-remaining"]).toBe("99");
    expect(h.stub.lastHeaders()?.["x-hirakumi-hop"]).toBe("1");
    const [row] = await h.sql<{ remaining: number }[]>`select remaining from credit_tokens where id = ${t.id}`;
    expect(row.remaining).toBe(99);
  });

  it("422 and no credit used when the answer breaks the promise", async () => {
    const t = await insertActiveToken(h.sql, h.seeded);
    h.stub.setMode("empty");
    const r = await call().set("authorization", `Bearer ${t.token}`);
    expect(r.status).toBe(422);
    expect(r.headers["x-credits-remaining"]).toBe("100");
  });

  it("503 while the API is Down or its sales are paused", async () => {
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    expect((await call()).status).toBe(503);
    h.health.reset(h.seeded.apiId);
    await h.sql`update apis set ownership_paused_at = now(), health = 'healthy' where id = ${h.seeded.apiId}`;
    h.registry.invalidate(h.seeded.apiId);
    const r = await call();
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("selling_paused");
  });

  it("400 for bad input, 404 for another path (with the listing), 405 for another method", async () => {
    expect((await call("/price?x=1")).status).toBe(400);
    const nf = await call("/nope");
    expect(nf.status).toBe(404);
    expect(nf.body).toMatchObject({ error: "operation_not_found", listingUrl: `https://web.test/p/${h.seeded.apiId}` });
    const post = await request(app).post("/price").set("host", HOST).send({});
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET");
    expect((await call("/price/..%2F..")).status).toBe(400);
  });

  it("never reaches Hirakumi's own routes on a seller's host", async () => {
    for (const path of ["/healthz", `/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`, `/internal/apis/${h.seeded.apiId}/health`, `/r/${h.seeded.ruleHash}`]) {
      const r = await request(app).get(path).set("host", HOST).set(AUTH);
      expect(r.status).toBe(404);
      expect(r.body.ok).toBeUndefined();
      expect(r.body.health).toBeUndefined();
      expect(r.body.ruleHash).toBeUndefined();
    }
    const reload = await request(app).post(`/internal/apis/${h.seeded.apiId}/reload`).set("host", HOST).set(AUTH);
    expect(reload.status).not.toBe(200);
  });

  it("508 for a request that carries Hirakumi's own hop header", async () => {
    const r = await call().set("x-hirakumi-hop", "1");
    expect(r.status).toBe(508);
    expect(h.stub.hits()).toBe(0);
  });

  it("508 for the hop header on the gateway's own host too, so an origin pointing at the gateway never loops", async () => {
    const r = await request(app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("x-hirakumi-hop", "1");
    expect(r.status).toBe(508);
  });

  it("calls an origin that shares Hirakumi's address (another site on the same host): only the hop header stops loops", async () => {
    const t = await insertActiveToken(h.sql, h.seeded);
    const r = await request(app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${t.token}`);
    expect(r.status).toBe(200);
    expect(h.stub.lastHeaders()?.["x-hirakumi-hop"]).toBe("1");
  });

  it("leaves the native routes as they were", async () => {
    const r = await request(app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`);
    expect(r.status).toBe(402);
    expect(r.body.message).toBeUndefined();
    expect(r.body.listingUrl).toBeUndefined();
    expect(r.headers.link).toBeUndefined();
    expect((await request(app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", "Bearer nope")).status).toBe(401);
    expect((await request(app).get("/healthz").set("host", "gw.test")).body).toEqual({ ok: true });
    expect((await request(app).get("/healthz").set("host", "gateway:4021")).body).toEqual({ ok: true });
  });
});

describe("hosts that aren't served", () => {
  it("421 for an unknown host, a detached or disabled one", async () => {
    expect((await call()).status).toBe(421);
    await attachDomain("detached");
    expect((await call()).status).toBe(421);
    await h.sql`update api_domains set status = 'disabled'`;
    domains.invalidate(HOST);
    expect((await call()).status).toBe(421);
    await h.sql`update api_domains set status = 'pending_dns'`;
    domains.invalidate(HOST);
    expect((await call()).status).toBe(402); // the seller moved DNS before clicking Check connection
  });

  it("404 when the API is not live", async () => {
    await attachDomain();
    await h.sql`update apis set state = 'registering' where id = ${h.seeded.apiId}`;
    h.registry.invalidate(h.seeded.apiId);
    expect((await call()).status).toBe(404);
  });
});

describe("TLS ask", () => {
  it("allows a certificate only for a served host whose TXT was verified", async () => {
    const ask = tlsAskApp(domains);
    const asked = async (d: string) => (await request(ask).get(`/tls-ask?domain=${encodeURIComponent(d)}`)).status;
    expect(await asked(HOST)).toBe(403);
    await attachDomain("pending_dns", false);
    expect(await asked(HOST)).toBe(403);
    await h.sql`update api_domains set txt_verified_at = now()`;
    domains.invalidate(HOST);
    expect(await asked(HOST)).toBe(200);
    expect(await asked(`${HOST.toUpperCase()}.`)).toBe(200);
    expect(await asked("52.70.235.103")).toBe(403);
    expect(await asked("gateway")).toBe(403);
    expect((await request(ask).get("/tls-ask")).status).toBe(403);
    await h.sql`update api_domains set status = 'detached'`;
    domains.invalidate(HOST);
    expect(await asked(HOST)).toBe(403);
    expect(await tlsAskDecision(domains, "other.test")).toBe(false);
    expect((await request(ask).get("/internal/apis/x/health")).status).toBe(404);
  });
});

describe("routed check", () => {
  const EDGE = ["52.70.235.103"];
  it("follows the CNAME chain and wants every address to be ours", async () => {
    resolver.set(HOST, { cname: "52-70-235-103.sslip.io" });
    resolver.set("52-70-235-103.sslip.io", { a: ["52.70.235.103"] });
    expect(await checkRouted(resolver, HOST, EDGE)).toMatchObject({ outcome: "routed", chain: ["52-70-235-103.sslip.io"], addresses: ["52.70.235.103"] });
  });
  it("is not routed with a foreign AAAA record, an old A record or no record", async () => {
    resolver.set(HOST, { a: ["52.70.235.103"], aaaa: ["2001:db8::1"] });
    const r = await checkRouted(resolver, HOST, EDGE);
    expect(r).toMatchObject({ outcome: "not_routed" });
    expect(r.detail).toContain("2001:db8::1 (AAAA)");
    resolver.set(HOST, { a: ["1.2.3.4"] });
    expect((await checkRouted(resolver, HOST, EDGE)).outcome).toBe("not_routed");
    expect((await checkRouted(resolver, "none.test", EDGE)).outcome).toBe("not_routed");
  });
  it("is an error, not a miss, when DNS does not answer", async () => {
    resolver.set(HOST, { fail: "ETIMEOUT" });
    expect((await checkRouted(resolver, HOST, EDGE)).outcome).toBe("error");
  });
  it("refuses an endless CNAME loop", async () => {
    resolver.set("a.test", { cname: "b.test" });
    resolver.set("b.test", { cname: "a.test" });
    expect((await checkRouted(resolver, "a.test", EDGE)).outcome).toBe("not_routed");
  });
});

describe("internal front-door routes", () => {
  it("Check connection makes a pending host active once it resolves here and the front door answers", async () => {
    await attachDomain("pending_dns");
    resolver.set(HOST, { a: ["1.2.3.4"] });
    const miss = await request(app).post(`/internal/domains/${HOST}/check`).set(AUTH);
    expect(miss.body).toMatchObject({ ok: false, outcome: "not_routed" });
    resolver.set(HOST, { cname: "52-70-235-103.sslip.io" });
    resolver.set("52-70-235-103.sslip.io", { a: ["52.70.235.103"] });
    const ok = await request(app).post(`/internal/domains/${HOST}/check`).set(AUTH);
    expect(ok.body).toMatchObject({ ok: true, outcome: "routed" });
    const [d] = await h.sql`select status, routed_at from api_domains where host = ${HOST}`;
    expect(d.status).toBe("active");
    expect(d.routed_at).not.toBeNull();
    expect((await request(app).post(`/internal/domains/${HOST}/check`)).status).toBe(401);
  });

  it("reports the state and the DNS record to add", async () => {
    await attachDomain("pending_dns");
    const r = await request(app).get(`/internal/front-door/${h.seeded.apiId}`).set(AUTH);
    expect(r.body).toMatchObject({
      publicHost: HOST, domain: { host: HOST, status: "pending_dns" },
      dnsTarget: { cname: "52-70-235-103.sslip.io", a: "52.70.235.103", aaaa: null },
    });
  });

  it("stop detaches the host at once", async () => {
    await attachDomain();
    expect((await call()).status).toBe(402);
    const r = await request(app).post(`/internal/front-door/${h.seeded.apiId}/stop`).set(AUTH);
    expect(r.body).toEqual({ ok: true, host: HOST });
    expect((await call()).status).toBe(421);
  });

  it("refuses an origin switch without a key, to the same host, or without the TXT record at the new origin", async () => {
    await h.sql`update apis set origin = 'https://api.seller.test' where id = ${h.seeded.apiId}`;
    const key = { in: "header", name: "x-api-key", sealed: "hks2.x", hint: "abcd" };
    const post = (body: unknown) => request(app).post(`/internal/front-door/${h.seeded.apiId}/origin`).set(AUTH).send(body as object);
    expect((await post({ origin: "https://origin.seller.test" })).body.error).toBe("key_required");
    expect((await post({ origin: "https://api.seller.test", upstreamAuth: key })).body.error).toBe("same_host");
    expect((await post({ origin: "https://origin.seller.test/v1", upstreamAuth: key })).body.error).toBe("bad_origin");
    expect((await post({ origin: "ftp://origin.seller.test", upstreamAuth: key })).body.error).toBe("bad_origin");
    const noTxt = await post({ origin: "https://origin.seller.test", upstreamAuth: key });
    expect(noTxt.status).toBe(422);
    expect(noTxt.body).toMatchObject({ error: "origin_txt", record: "_hirakumi.origin.seller.test", code: "hkv_code" });
    h.dns.set("_hirakumi.origin.seller.test", ["hkv_code"]);
    expect((await post({ origin: "https://origin.seller.test", upstreamAuth: key })).body.error).toBe("public_txt");
    h.dns.set("_hirakumi.api.seller.test", ["hkv_code"]);
    // The gateway has no key to open the sealed one with here, so nothing is switched.
    expect((await post({ origin: "https://origin.seller.test", upstreamAuth: key })).body.error).toBe("key_unreadable");
    const [api] = await h.sql`select origin, public_host from apis where id = ${h.seeded.apiId}`;
    expect(api).toEqual({ origin: "https://api.seller.test", public_host: null });
  });

  it("opens a key sealed for the new origin and switches nothing when the test calls there fail", async () => {
    const keys = generateUpstreamAuthKeys();
    const app2 = createApp({ ...h.deps, domains, config: { ...h.config, upstreamAuthPrivateKey: keys.privateKey } });
    await h.sql`update apis set origin = 'https://api.seller.test' where id = ${h.seeded.apiId}`;
    h.dns.set("_hirakumi.origin.seller.test", ["hkv_code"]);
    h.dns.set("_hirakumi.api.seller.test", ["hkv_code"]);
    const ctx = { apiId: h.seeded.apiId, in: "header" as const, name: "x-api-key", pathPrefix: "/" };
    const sealedFor = (origin: string) => ({ in: "header", name: "x-api-key", sealed: sealUpstreamSecret(keys.publicKey, { ...ctx, origin }, "sk_secret_value"), hint: "alue" });
    const post = (body: unknown) => request(app2).post(`/internal/front-door/${h.seeded.apiId}/origin`).set(AUTH).send(body as object);
    // A key sealed for the old address can't be opened for the new one.
    expect((await post({ origin: "https://origin.seller.test", upstreamAuth: sealedFor("https://api.seller.test") })).body.error).toBe("key_unreadable");
    const r = await post({ origin: "https://origin.seller.test", upstreamAuth: sealedFor("https://origin.seller.test") });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "tests_failed", tests: [{ opId: "getPrice", ok: false }] });
    expect(JSON.stringify(r.body)).not.toContain("sk_secret_value");
    expect((await h.sql`select origin from apis where id = ${h.seeded.apiId}`)[0].origin).toBe("https://api.seller.test");
  });
});

describe("monitor re-check of front-door hosts", () => {
  const monitor = () => new Monitor({
    sql: h.sql, registry: h.registry, health: h.health, txtLookup: h.dns.lookup, addressResolver: resolver, domains, random: () => 0.5,
    config: { ...h.config, edgeIps: ["52.70.235.103"] },
  });
  const due = async () => { await h.sql`update api_domains set next_check_at = now() - interval '1 minute'`; };

  it("two missing TXT checks disable the host (421) and tell the seller; DNS timeouts don't count", async () => {
    await attachDomain();
    resolver.set(HOST, { a: ["52.70.235.103"] });
    const m = monitor();
    await due();
    await m.recheckDomainsDue();
    expect((await h.sql`select failures, status from api_domains`)[0]).toEqual({ failures: 1, status: "active" });
    h.dns.fail(`_hirakumi.${HOST}`, "ETIMEOUT");
    await due();
    await m.recheckDomainsDue();
    expect((await h.sql`select failures, status from api_domains`)[0]).toEqual({ failures: 1, status: "active" });
    h.dns.clear(`_hirakumi.${HOST}`);
    await due();
    await m.recheckDomainsDue();
    expect((await h.sql`select status from api_domains`)[0].status).toBe("disabled");
    expect((await call()).status).toBe(421);
    const [msg] = await h.sql<{ body: string }[]>`select body from messages where api_id = ${h.seeded.apiId}`;
    expect(msg.body).toContain(`_hirakumi.${HOST}`);
    expect(msg.body).not.toMatch(/[\u2013\u2014]/);
    // Native sales go on.
    expect((await request(app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`)).status).toBe(402);
    h.dns.set(`_hirakumi.${HOST}`, ["hkv_code"]);
    await due();
    await m.recheckDomainsDue();
    expect((await h.sql`select status from api_domains`)[0].status).toBe("active");
  });

  it("two checks that find the host pointing elsewhere detach it", async () => {
    await attachDomain();
    h.dns.set(`_hirakumi.${HOST}`, ["hkv_code"]);
    resolver.set(HOST, { a: ["52.70.235.103"], aaaa: ["2001:db8::9"] });
    const m = monitor();
    for (let i = 0; i < 2; i++) { await due(); await m.recheckDomainsDue(); }
    expect((await h.sql`select status from api_domains`)[0].status).toBe("detached");
    expect((await h.sql`select public_host from apis where id = ${h.seeded.apiId}`)[0].public_host).toBeNull();
    expect((await call()).status).toBe(421);
  });

  it("only schedules a host seen for the first time", async () => {
    await attachDomain();
    await monitor().recheckDomainsDue();
    const [d] = await h.sql<{ next_check_at: Date | null; failures: number }[]>`select next_check_at, failures from api_domains`;
    expect(d.next_check_at).not.toBeNull();
    expect(h.dns.asked).toEqual([]);
  });
});
