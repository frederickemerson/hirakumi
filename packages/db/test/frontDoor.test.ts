import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing";
import { MIGRATIONS_DIR } from "../src/migrate";
import {
  activateDomain, attachFrontDoor, detachApiFrontDoor, getDomainRoute, getFrontDoorState, getProvenVerifyCode, listDomainRecheckTargets,
  recordDomainRecheck, tlsAllowed,
} from "../src/frontDoor";

const KEY = { in: "header" as const, name: "x-api-key", sealed: "hks2.sealed", hint: "abcd" };

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
  const sql = db.sql;
  await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1a'), ('sel_b', 'addr_test1b')`;
  await sql`
    insert into apis (id, seller_id, name, origin, path_prefix, openapi_url, state)
    values ('api_a', 'sel_a', 'A', 'https://api.seller.com', '/v1', 'https://api.seller.com/openapi.json', 'live'),
           ('api_b', 'sel_b', 'B', 'https://api.other.com', '/', 'https://api.other.com/openapi.json', 'live')`;
  await sql`
    insert into challenges (id, api_id, kind, token, expires_at, consumed_at, proof)
    values ('ch_a', 'api_a', 'dns', 'hkv_a', now() + interval '1 year', now(), ${sql.json({ passedAt: new Date().toISOString() })})`;
});
afterEach(async () => { await db.drop(); });

const attach = (over: Partial<Parameters<typeof attachFrontDoor>[1]> = {}) => attachFrontDoor(db.sql, {
  apiId: "api_a", expectedOrigin: "https://api.seller.com", newOrigin: "https://origin.seller.com", publicHost: "api.seller.com",
  upstreamAuth: KEY, ...over,
});

describe("migration 0020_front_door.sql", () => {
  it("can run again, and refuses IP addresses and mixed case as hosts", async () => {
    await db.sql.unsafe(await readFile(join(MIGRATIONS_DIR, "0020_front_door.sql"), "utf8"));
    for (const host of ["52.70.235.103", "API.seller.com", "localhost", "a:b.com"]) {
      await expect(db.sql`insert into api_domains (host, seller_id, status) values (${host}, 'sel_a', 'active')`).rejects.toThrow(/api_domains_host_check/);
    }
    await expect(db.sql`insert into api_domains (host, seller_id, status) values ('x.com', 'sel_a', 'gone')`).rejects.toThrow(/status_check/);
  });
});

describe("attachFrontDoor", () => {
  it("switches the origin and key, and makes the old host a pending domain the front door serves", async () => {
    expect(await attach()).toEqual({ ok: true, host: "api.seller.com" });
    const [api] = await db.sql`select origin, public_host, upstream_auth from apis where id = 'api_a'`;
    expect(api).toEqual({ origin: "https://origin.seller.com", public_host: "api.seller.com", upstream_auth: KEY });
    const route = await getDomainRoute(db.sql, "api.seller.com");
    expect(route).toMatchObject({ status: "pending_dns", sellerId: "sel_a", apis: [{ id: "api_a", pathPrefix: "/v1" }] });
    expect(tlsAllowed(route)).toBe(true);
    expect(await getDomainRoute(db.sql, "nope.com")).toBeNull();
    expect(tlsAllowed(null)).toBe(false);
    expect(await getFrontDoorState(db.sql, "api_a")).toMatchObject({ origin: "https://origin.seller.com", publicHost: "api.seller.com", domain: { status: "pending_dns" } });
  });

  it("refuses when the address moved meanwhile, or the API is retired", async () => {
    expect(await attach({ expectedOrigin: "https://elsewhere.com" })).toMatchObject({ ok: false, reason: "origin_changed" });
    await db.sql`update apis set state = 'retired' where id = 'api_a'`;
    expect(await attach()).toMatchObject({ ok: false, reason: "retired" });
  });

  it("refuses a host another listing uses as its address, or another seller's served domain", async () => {
    expect(await attach({ publicHost: "api.other.com" })).toMatchObject({ ok: false, reason: "host_in_use" });
    await db.sql`insert into api_domains (host, seller_id, status, txt_verified_at) values ('api.seller.com', 'sel_b', 'active', now())`;
    expect(await attach()).toMatchObject({ ok: false, reason: "host_in_use" });
    await db.sql`update api_domains set status = 'detached'`;
    expect(await attach()).toEqual({ ok: true, host: "api.seller.com" }); // released: whoever proves it now takes it
    expect((await getDomainRoute(db.sql, "api.seller.com"))?.sellerId).toBe("sel_a");
  });

  it("caps hosts per seller and new hosts per hour", async () => {
    await db.sql`insert into api_domains (host, seller_id, status) values ('a.x.com', 'sel_a', 'active'), ('b.x.com', 'sel_a', 'pending_dns')`;
    expect(await attach({ limits: { maxPerSeller: 2, maxNewPerHour: 20 } })).toMatchObject({ ok: false, reason: "seller_limit" });
    expect(await attach({ limits: { maxPerSeller: 3, maxNewPerHour: 2 } })).toMatchObject({ ok: false, reason: "busy" });
    expect(await attach({ limits: { maxPerSeller: 3, maxNewPerHour: 3 } })).toMatchObject({ ok: true });
  });
});

describe("activate and detach", () => {
  it("activates, then detaching clears public_host and turns the certificate off", async () => {
    await attach();
    await activateDomain(db.sql, "api.seller.com", new Date(Date.now() + 3_600_000));
    expect((await getDomainRoute(db.sql, "api.seller.com"))?.status).toBe("active");
    expect(await detachApiFrontDoor(db.sql, "api_a")).toEqual({ host: "api.seller.com", detached: true });
    const route = await getDomainRoute(db.sql, "api.seller.com");
    expect(route).toMatchObject({ status: "detached", apis: [] });
    expect(tlsAllowed(route)).toBe(false);
    expect(await detachApiFrontDoor(db.sql, "api_a")).toBeNull();
  });
});

describe("recordDomainRecheck", () => {
  const next = new Date(Date.now() + 3_600_000);
  const messages = { disabled: "disabled msg", detached: "detached msg", active: "back msg" };

  it("two TXT misses in a row disable the host and tell the seller; the code back restores it", async () => {
    await attach();
    await activateDomain(db.sql, "api.seller.com", next);
    expect((await listDomainRecheckTargets(db.sql))[0]).toMatchObject({ host: "api.seller.com", codes: ["hkv_a"] });
    expect(await getProvenVerifyCode(db.sql, "api_a")).toBe("hkv_a");
    const r = (outcome: "pass" | "txt_missing" | "not_routed" | "error") =>
      recordDomainRecheck(db.sql, { host: "api.seller.com", outcome, detail: "d", nextAt: next, messages });
    expect(await r("txt_missing")).toEqual({ status: "active", failures: 1, changed: false });
    expect(await r("error")).toEqual({ status: "active", failures: 1, changed: false }); // a DNS timeout neither counts nor resets
    expect(await r("txt_missing")).toEqual({ status: "disabled", failures: 2, changed: true });
    const msgs = await db.sql`select body from messages where api_id = 'api_a'`;
    expect(msgs.map((m) => m.body)).toEqual(["disabled msg"]);
    expect(tlsAllowed(await getDomainRoute(db.sql, "api.seller.com"))).toBe(false);
    expect(await r("pass")).toEqual({ status: "active", failures: 0, changed: true });
  });

  it("two not-routed checks in a row detach an active host and clear public_host", async () => {
    await attach();
    await activateDomain(db.sql, "api.seller.com", next);
    const r = (outcome: "txt_missing" | "not_routed") =>
      recordDomainRecheck(db.sql, { host: "api.seller.com", outcome, detail: "d", nextAt: next, messages });
    expect(await r("not_routed")).toMatchObject({ failures: 1, status: "active" });
    expect(await r("txt_missing")).toMatchObject({ failures: 1, status: "active" }); // another kind starts again
    expect(await r("not_routed")).toMatchObject({ failures: 1 });
    expect(await r("not_routed")).toEqual({ status: "detached", failures: 2, changed: true });
    expect((await db.sql`select public_host from apis where id = 'api_a'`)[0].public_host).toBeNull();
    expect(await listDomainRecheckTargets(db.sql)).toEqual([]);
  });

  it("never detaches a pending host for routing (the seller has not moved DNS yet)", async () => {
    await attach();
    for (let i = 0; i < 3; i++) {
      await recordDomainRecheck(db.sql, { host: "api.seller.com", outcome: "not_routed", detail: "d", nextAt: next, messages });
    }
    expect((await getDomainRoute(db.sql, "api.seller.com"))?.status).toBe("pending_dns");
  });
});
