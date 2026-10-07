import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { newId, newVerifyCode } from "@hirakumi/core";
import { listOwnershipRecheckTargets } from "@hirakumi/db";
import { Monitor } from "../src/monitor";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

let h: Harness;
let monitor: Monitor;
beforeEach(async () => {
  h = await makeHarness();
  monitor = new Monitor({ sql: h.sql, registry: h.registry, health: h.health, config: h.config, txtLookup: h.dns.lookup });
});
afterEach(async () => { await h.close(); });

const HOUR = 3_600_000;

/** Ownership proven by header (before the DNS proof): a 'header' code that passed the check and was consumed when the seller signed. */
async function verifiedWithHeader(apiId = h.seeded.apiId): Promise<string> {
  const code = newVerifyCode();
  await h.sql`
    insert into challenges (id, api_id, kind, token, expires_at, consumed_at, proof)
    values (${newId("ch")}, ${apiId}, 'header', ${code}, now() + interval '10 years', now(),
            ${h.sql.json({ passedAt: new Date().toISOString(), triedUrl: `${h.stub.origin}/` })})`;
  return code;
}
/** Ownership proven the old way (the code in the OpenAPI file), like the live listing api_eejiaioyqt. */
async function verifiedTheOldWay(apiId = h.seeded.apiId): Promise<void> {
  await h.sql`
    insert into challenges (id, api_id, kind, token, expires_at, consumed_at)
    values (${newId("ch")}, ${apiId}, 'openapi', ${newVerifyCode()}, now() + interval '10 years', now())`;
}
const serveRoot = (headers: Record<string, string>) => h.stub.setFile("/", "<html>hi</html>", { contentType: "text/html", headers });
const recheck = () => monitor.recheckOwnership(h.seeded.apiId);
const offer = () => request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`);
const buyPack = () => request(h.app).post(`/a/${h.seeded.apiId}/packs/${h.seeded.packId}`);
const paused = async () => (await h.sql<{ p: Date | null }[]>`select ownership_paused_at as p from apis where id = ${h.seeded.apiId}`)[0].p !== null;
const sellerMessages = () => h.sql<{ body: string }[]>`select body from messages where api_id = ${h.seeded.apiId} and author = 'coworker' order by id`;

describe("legacy ownership re-check (X-Hirakumi-Verify at the base URL, for APIs proven by header)", () => {
  it("only re-checks APIs verified with a header code; an API verified the old way is never checked or paused", async () => {
    await verifiedTheOldWay();
    serveRoot({});
    expect(await listOwnershipRecheckTargets(h.sql)).toEqual([]);
    for (let i = 0; i < 3; i++) await monitor.recheckDue(new Date(Date.now() + i * 7 * HOUR));
    expect(h.stub.fileHits("/")).toBe(0);
    expect(await paused()).toBe(false);
    expect((await offer()).status).toBe(402);
  });

  it("uses the code the seller proved with, and keeps selling while the header is there", async () => {
    const code = await verifiedWithHeader();
    serveRoot({ "X-Hirakumi-Verify": code });
    expect(await recheck()).toMatchObject({ outcome: "pass", paused: false });
    expect(h.stub.fileHits("/")).toBe(1);
    expect((await offer()).status).toBe(402);
  });

  it("pauses new sales after two checks in a row without the header, and keeps existing credits working", async () => {
    await verifiedWithHeader();
    const { token } = await insertActiveToken(h.sql, h.seeded, 3);
    serveRoot({});
    expect(await recheck()).toMatchObject({ outcome: "fail", reason: "missing", paused: false });
    expect(await paused()).toBe(false);
    expect((await offer()).status).toBe(402);

    expect(await recheck()).toMatchObject({ outcome: "fail", reason: "missing", paused: true, changed: true });
    expect(await paused()).toBe(true);
    const refused = await offer();
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ error: "selling_paused" });
    expect(refused.body.message).toMatch(/ownership code is missing/);
    expect(refused.body.message).toMatch(/Credits you already bought still work/);
    expect((await buyPack()).body).toMatchObject({ error: "selling_paused" });
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/availability`)).status).toBe(503);

    const paid = await offer().set("authorization", `Bearer ${token}`);
    expect(paid.status).toBe(200);
    expect(paid.headers["x-credits-remaining"]).toBe("2");

    const [msg] = await sellerMessages();
    expect(msg.body).toMatch(/paused new sales/);
    expect(msg.body).toMatch(/X-Hirakumi-Verify/);
  });

  it("a wrong code counts like a missing header", async () => {
    await verifiedWithHeader();
    serveRoot({ "X-Hirakumi-Verify": newVerifyCode() });
    await recheck();
    expect(await recheck()).toMatchObject({ outcome: "fail", reason: "mismatch", paused: true });
  });

  it("a network error is not a mismatch: it neither counts nor resets", async () => {
    await verifiedWithHeader();
    serveRoot({});
    expect(await recheck()).toMatchObject({ outcome: "fail", paused: false });
    await h.sql`update apis set origin = 'http://127.0.0.1:1' where id = ${h.seeded.apiId}`;
    for (let i = 0; i < 3; i++) expect(await recheck()).toMatchObject({ outcome: "error", reason: "unreachable", paused: false });
    expect(await paused()).toBe(false);
    await h.sql`update apis set origin = ${h.stub.origin} where id = ${h.seeded.apiId}`;
    expect(await recheck()).toMatchObject({ outcome: "fail", paused: true });
  });

  it("a passing check in between starts the count again", async () => {
    const code = await verifiedWithHeader();
    serveRoot({});
    await recheck();
    serveRoot({ "X-Hirakumi-Verify": code });
    await recheck();
    serveRoot({});
    expect(await recheck()).toMatchObject({ outcome: "fail", paused: false });
  });

  it("the header back restores selling and tells the seller", async () => {
    const code = await verifiedWithHeader();
    serveRoot({});
    await recheck();
    await recheck();
    expect((await offer()).status).toBe(503);
    serveRoot({ "X-Hirakumi-Verify": code });
    expect(await recheck()).toMatchObject({ outcome: "pass", paused: false, changed: true });
    expect(await paused()).toBe(false);
    expect((await offer()).status).toBe(402);
    const bodies = (await sellerMessages()).map((m) => m.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatch(/selling it again/);
  });

  it("the pause survives a gateway restart", async () => {
    await verifiedWithHeader();
    serveRoot({});
    await recheck();
    await recheck();
    h.registry.invalidate(h.seeded.apiId);
    expect((await offer()).status).toBe(503);
  });

  it("schedules checks hours apart with jitter, and checks again sooner after a failure", async () => {
    const code = await verifiedWithHeader();
    serveRoot({ "X-Hirakumi-Verify": code });
    const t0 = new Date();
    // First sight: scheduled within one interval, not checked at once (a deploy must not check every API together).
    await monitor.recheckDue(t0);
    expect(h.stub.fileHits("/")).toBe(0);
    const [first] = await listOwnershipRecheckTargets(h.sql);
    expect(first.next_check_at!.getTime()).toBeGreaterThan(t0.getTime());
    expect(first.next_check_at!.getTime()).toBeLessThanOrEqual(t0.getTime() + h.config.ownershipRecheckMs);

    const t1 = new Date(first.next_check_at!.getTime() + 1);
    await monitor.recheckDue(t1);
    expect(h.stub.fileHits("/")).toBe(1);
    const [afterPass] = await listOwnershipRecheckTargets(h.sql);
    const gap = afterPass.next_check_at!.getTime() - t1.getTime();
    expect(gap).toBeGreaterThanOrEqual(h.config.ownershipRecheckMs * 0.9);
    expect(gap).toBeLessThanOrEqual(h.config.ownershipRecheckMs * 1.1);
    await monitor.recheckDue(new Date(t1.getTime() + 60_000));
    expect(h.stub.fileHits("/")).toBe(1); // not due yet

    serveRoot({});
    const t2 = new Date(afterPass.next_check_at!.getTime() + 1);
    await monitor.recheckDue(t2);
    const [afterFail] = await listOwnershipRecheckTargets(h.sql);
    expect(afterFail.next_check_at!.getTime() - t2.getTime()).toBeLessThanOrEqual(h.config.ownershipRetryMs * 1.1);
  });

  it("two checks at once count once", async () => {
    await verifiedWithHeader();
    serveRoot({});
    await Promise.all([recheck(), recheck()]);
    expect(await paused()).toBe(false);
  });
});

/** Ownership proven by DNS: a 'dns' code that passed the check and was consumed when the seller signed. */
async function verifiedWithDns(apiId = h.seeded.apiId): Promise<string> {
  const code = newVerifyCode();
  await h.sql`update apis set origin = 'https://price.example.dev' where id = ${apiId}`;
  await h.sql`
    insert into challenges (id, api_id, kind, token, expires_at, consumed_at, proof)
    values (${newId("ch")}, ${apiId}, 'dns', ${code}, now() + interval '10 years', now(),
            ${h.sql.json({ passedAt: new Date().toISOString(), record: "_hirakumi.price.example.dev" })})`;
  return code;
}
const RECORD = "_hirakumi.price.example.dev";

describe("ownership re-check (the _hirakumi TXT record, from time to time)", () => {
  it("uses the code the seller proved with, looks up DNS only, and keeps selling while the record is there", async () => {
    const code = await verifiedWithDns();
    h.dns.set(RECORD, [code]);
    expect((await listOwnershipRecheckTargets(h.sql))[0]).toMatchObject({ kind: "dns", token: code });
    expect(await recheck()).toMatchObject({ outcome: "pass", paused: false });
    expect(h.dns.asked).toEqual([RECORD]);
    expect(h.stub.fileHits("/")).toBe(0);
    expect((await offer()).status).toBe(402);
  });

  it("pauses new sales after two lookups in a row without the record, tells the seller, and resumes when it is back", async () => {
    const code = await verifiedWithDns();
    expect(await recheck()).toMatchObject({ outcome: "fail", reason: "missing", paused: false });
    expect(await recheck()).toMatchObject({ outcome: "fail", reason: "missing", paused: true, changed: true });
    expect((await offer()).body).toMatchObject({ error: "selling_paused" });
    const [msg] = await sellerMessages();
    expect(msg.body).toMatch(/TXT record at _hirakumi/);
    h.dns.set(RECORD, [code]);
    expect(await recheck()).toMatchObject({ outcome: "pass", paused: false, changed: true });
    expect((await sellerMessages()).map((m) => m.body)[1]).toMatch(/_hirakumi TXT record is back/);
    expect((await offer()).status).toBe(402);
  });

  it("a DNS timeout or server failure neither counts nor resets", async () => {
    await verifiedWithDns();
    expect(await recheck()).toMatchObject({ outcome: "fail", paused: false });
    h.dns.fail(RECORD, "ETIMEOUT");
    for (let i = 0; i < 3; i++) expect(await recheck()).toMatchObject({ outcome: "error", paused: false });
    h.dns.fail(RECORD, "ESERVFAIL");
    expect(await recheck()).toMatchObject({ outcome: "error", paused: false });
    h.dns.clear(RECORD);
    expect(await recheck()).toMatchObject({ outcome: "fail", paused: true });
  });

  it("another code at the name counts like a missing record", async () => {
    await verifiedWithDns();
    h.dns.set(RECORD, [newVerifyCode()]);
    await recheck();
    expect(await recheck()).toMatchObject({ outcome: "fail", reason: "mismatch", paused: true });
  });
});
