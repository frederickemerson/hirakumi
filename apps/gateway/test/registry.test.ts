import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateUpstreamAuthKeys, sealUpstreamBag, sealUpstreamSecret, type StoredUpstreamAuth, type StoredUpstreamBag, type UpstreamBag, type UpstreamPartPlacement,
} from "@hirakumi/core";
import { createTestDb, type TestDb } from "@hirakumi/db/testing";
import { HealthTracker } from "../src/health";
import { ADDRESS_CHANGED, ApiRegistry, escrowOperation, KEYS_UNAVAILABLE, openCredential, primaryRule } from "../src/registry";
import { seedLiveApi, type Seeded } from "./helpers";

let db: TestDb; let s: Seeded; let health: HealthTracker; let registry: ApiRegistry;
beforeEach(async () => {
  db = await createTestDb();
  s = await seedLiveApi(db.sql, "https://price.example", { health: "down" });
  health = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
  registry = new ApiRegistry(db.sql, health);
});
afterEach(async () => { await db.drop(); });

describe("ApiRegistry", () => {
  it("loads ops by op_id with a compiled rule and seeds health from the DB", async () => {
    const l = await registry.get(s.apiId);
    const op = l?.ops.get("getPrice");
    expect(op?.rule?.hash).toBe(s.ruleHash);
    expect(op?.ruleRow?.id).toBe(s.ruleId);
    expect(l?.packs.map((p) => p.id)).toEqual([s.packId]);
    expect(health.get(s.apiId)?.health).toBe("down");
    expect(escrowOperation(l!)?.row.id).toBe(s.operationId);
    expect(primaryRule(l!)?.hash).toBe(s.ruleHash);
  });
  it("validates input with coercion and reports plain reasons", async () => {
    const op = (await registry.get(s.apiId))!.ops.get("getPrice")!;
    expect(op.validateInput({ symbol: "ADA" })).toEqual({ ok: true, value: { symbol: "ADA" } });
    expect(op.validateInput({})).toEqual({ ok: false, reasons: ["/symbol is missing"] });
    expect(op.validateInput({ symbol: "ADA", x: "1" })).toMatchObject({ ok: false });
  });
  it("drops a rule whose stored hash does not match its definition", async () => {
    await db.sql`update rules set hash = 'sha256:tampered' where id = ${s.ruleId}`;
    const op = (await registry.get(s.apiId, { fresh: true }))!.ops.get("getPrice")!;
    expect(op.rule).toBeNull();
  });
  it("caches until invalidate(), which also forgets in-memory health", async () => {
    await registry.get(s.apiId);
    await db.sql`update packs set price_micros = 3000000 where id = ${s.packId}`;
    expect((await registry.get(s.apiId))!.packs[0].price_micros).toBe("2000000");
    registry.invalidate(s.apiId);
    expect(health.get(s.apiId)).toBeUndefined();
    expect((await registry.get(s.apiId))!.packs[0].price_micros).toBe("3000000");
  });
  it("returns null for unknown APIs and does not cache the miss", async () => {
    expect(await registry.get("api_nope")).toBeNull();
  });
});

const keys = generateUpstreamAuthKeys();
const AT = { origin: "https://price.example", pathPrefix: "/" };
const KEY = "sk_live_0123456789abcdefWXYZ";
const PARTS: UpstreamPartPlacement[] = [{ in: "header", name: "apikey" }, { in: "header", name: "Authorization" }, { in: "header", name: "X-Version" }];
const BAG: UpstreamBag = { values: [KEY, `Bearer ${KEY}`, "2022-06-28"], fixed: [2], leak: [KEY, `Bearer ${KEY}`] };
/** A bag sealed for apiId at AT, stored as the web app stores it (hints are display only). */
const storedBag = (apiId: string, bag = BAG, parts = PARTS, at = AT): StoredUpstreamBag =>
  ({ v: 3, parts: parts.map((p) => ({ ...p, hint: "" })), sealed: sealUpstreamBag(keys.publicKey, { apiId, parts, ...at }, bag) });
const row = (id: string, upstream_auth: StoredUpstreamAuth | null, at = AT) => ({ id, upstream_auth, origin: at.origin, path_prefix: at.pathPrefix });

describe("openCredential", () => {
  it("opens a single key (hks2) exactly as before, with no auth field", () => {
    const sealed = sealUpstreamSecret(keys.publicKey, { apiId: "api_a", in: "header", name: "X-API-Key", ...AT }, KEY);
    const r = openCredential(row("api_a", { in: "header", name: "X-API-Key", sealed, hint: "WXYZ" }), keys.privateKey);
    expect(r).toStrictEqual({ credential: { in: "header", name: "X-API-Key", value: KEY }, credentialError: null });
  });
  it("opens a bag (hks3) to its parts in order and its leak list, with credential null", () => {
    const r = openCredential(row("api_a", storedBag("api_a")), keys.privateKey);
    expect(r.credential).toBeNull();
    expect(r.credentialError).toBeNull();
    expect(r.auth?.parts).toEqual([
      { in: "header", name: "apikey", value: KEY }, { in: "header", name: "Authorization", value: `Bearer ${KEY}` },
      { in: "header", name: "X-Version", value: "2022-06-28" },
    ]);
    expect(r.auth?.leakParts).toEqual(expect.arrayContaining([KEY, `Bearer ${KEY}`]));
    expect(r.auth?.leakParts).not.toContain("2022-06-28");
  });
  it("without the private key, either format is blocked with KEYS_UNAVAILABLE", () => {
    expect(KEYS_UNAVAILABLE).toBe("this API needs a key, and the gateway can't read keys right now");
    expect(openCredential(row("api_a", storedBag("api_a")), null)).toEqual({ credential: null, credentialError: KEYS_UNAVAILABLE });
  });
  it("a bag that is tampered, moved, malformed or fails the part rules is a row error", () => {
    const refused = (stored: unknown, id = "api_a") => {
      const r = openCredential(row(id, stored as StoredUpstreamAuth), keys.privateKey);
      expect(r.credential).toBeNull();
      expect(r.auth).toBeUndefined();
      expect(r.credentialError).toMatch(/could not be read/);
    };
    const s = storedBag("api_a");
    refused(s, "api_b");
    refused({ ...s, parts: [s.parts[1], s.parts[0], s.parts[2]] });
    refused({ ...s, parts: s.parts.slice(0, 2) });
    refused({ ...s, parts: [{ ...s.parts[0], in: "query" }, ...s.parts.slice(1)] });
    refused({ v: 3, sealed: s.sealed });
    refused({ ...s, sealed: s.sealed.replace(/^hks3\./, "hks2.") });
    // Sealed correctly, but the gateway's own checks refuse it: all parts fixed, a reserved header, CRLF.
    refused(storedBag("api_a", { ...BAG, fixed: [0, 1, 2] }));
    refused(storedBag("api_a", BAG, [PARTS[0], PARTS[1], { in: "header", name: "Accept-Encoding" }]));
    refused(storedBag("api_a", { ...BAG, values: [KEY, `Bearer ${KEY}`, "a\r\nX-Evil: 1"] }));
  });
  it("a bag saved before the API's address changed is blocked with ADDRESS_CHANGED; /v1 opens at /v1/", () => {
    const s = storedBag("api_a", BAG, PARTS, { ...AT, pathPrefix: "/v1" });
    expect(openCredential(row("api_a", s, { ...AT, pathPrefix: "/v1/" }), keys.privateKey).auth).toBeDefined();
    expect(openCredential(row("api_a", s, AT), keys.privateKey)).toEqual({ credential: null, credentialError: ADDRESS_CHANGED });
  });
  it("the registry loads a bag row with its opened parts", async () => {
    await db.sql`update apis set upstream_auth = ${db.sql.json(storedBag(s.apiId))} where id = ${s.apiId}`;
    const l = await new ApiRegistry(db.sql, health, keys.privateKey).get(s.apiId);
    expect(l?.api.credential).toBeNull();
    expect(l?.api.auth?.parts.map((p) => p.name)).toEqual(["apikey", "Authorization", "X-Version"]);
  });
});
