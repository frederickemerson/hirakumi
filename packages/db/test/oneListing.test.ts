import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeBasePath, normalizeOrigin } from "@hirakumi/core";
import { createDb, type Sql } from "../src/client";
import { migrate, MIGRATIONS_DIR } from "../src/migrate";
import { createTestDb, type TestDb } from "../src/testing";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";
const MIGRATION = "0010_one_api_one_listing.sql";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** A schema migrated only up to (not including) `stopBefore`, so data can be seeded the way production has it. */
async function schemaBefore(stopBefore: string): Promise<{ sql: Sql; dir: string }> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = createDb(TEST_URL, { max: 1 });
  await admin.unsafe(`create schema ${schema}`);
  await admin.end();
  const sql = createDb(TEST_URL, { searchPath: schema, max: 2 });
  const older = await mkdtemp(join(tmpdir(), "mig-"));
  for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql") && f < stopBefore)) {
    await copyFile(join(MIGRATIONS_DIR, f), join(older, f));
  }
  await migrate(sql, older);
  cleanup = async () => {
    await sql.end();
    const a = createDb(TEST_URL, { max: 1 });
    await a.unsafe(`drop schema if exists ${schema} cascade`);
    await a.end();
  };
  return { sql, dir: older };
}

async function seedApi(sql: Sql, a: { id: string; seller: string; origin: string; prefix: string; state: string; createdAt?: string }) {
  await sql`insert into sellers (id, cardano_addr) values (${a.seller}, ${`addr_test1${a.seller}`}) on conflict do nothing`;
  await sql`
    insert into apis (id, seller_id, name, origin, path_prefix, openapi_url, state, created_at)
    values (${a.id}, ${a.seller}, ${a.id}, ${a.origin}, ${a.prefix}, ${`${a.origin}/openapi.json`}, ${a.state},
            ${a.createdAt ?? new Date().toISOString()})`;
}

describe(`migration ${MIGRATION}`, () => {
  it("applies on a database that already has duplicate active APIs, keeps every row as it was, and flags the later ones", async () => {
    const { sql } = await schemaBefore(MIGRATION);
    // What dev and production can hold today: one base listed live twice and verified once, plus unproven attempts.
    await seedApi(sql, { id: "api_first", seller: "sel_a", origin: "http://localhost:4100", prefix: "/", state: "live", createdAt: "2026-10-01T00:00:00Z" });
    await seedApi(sql, { id: "api_second", seller: "sel_b", origin: "http://LOCALHOST:4100", prefix: "", state: "live", createdAt: "2026-10-02T00:00:00Z" });
    await seedApi(sql, { id: "api_third", seller: "sel_c", origin: "http://localhost:4100", prefix: "/", state: "ownership_verified", createdAt: "2026-09-30T00:00:00Z" });
    await seedApi(sql, { id: "api_trying", seller: "sel_d", origin: "http://localhost:4100", prefix: "/", state: "endpoints_confirmed" });
    await seedApi(sql, { id: "api_gone", seller: "sel_e", origin: "http://localhost:4100", prefix: "/", state: "retired" });

    expect((await migrate(sql))[0]).toBe(MIGRATION); // later migrations may follow

    const rows = await sql<{ id: string; state: string; base_legacy_duplicate: boolean }[]>`
      select id, state, base_legacy_duplicate from apis order by id`;
    expect(rows).toEqual([
      { id: "api_first", state: "live", base_legacy_duplicate: false }, // the oldest live listing keeps the base
      { id: "api_gone", state: "retired", base_legacy_duplicate: false },
      { id: "api_second", state: "live", base_legacy_duplicate: true },
      { id: "api_third", state: "ownership_verified", base_legacy_duplicate: true },
      { id: "api_trying", state: "endpoints_confirmed", base_legacy_duplicate: false },
    ]);
    // From now on the index holds: a new listing of that base can't become active.
    await expect(sql`update apis set state = 'ownership_verified' where id = 'api_trying'`).rejects.toThrow(/apis_active_base_uniq/);
  }, 30_000); // replays every migration twice; slow under a parallel workspace run

  it("applies cleanly on a database without duplicates", async () => {
    const { sql } = await schemaBefore(MIGRATION);
    await seedApi(sql, { id: "api_one", seller: "sel_a", origin: "https://h.com", prefix: "/v1", state: "live" });
    await seedApi(sql, { id: "api_two", seller: "sel_b", origin: "https://h.com", prefix: "/v10", state: "live" });
    expect((await migrate(sql))[0]).toBe(MIGRATION); // later migrations may follow
    const flagged = await sql`select id from apis where base_legacy_duplicate`;
    expect(flagged).toEqual([]);
  });
});

describe("the active-base index", () => {
  let db: TestDb;
  afterEach(() => undefined);

  it("normalizes exactly like @hirakumi/core", async () => {
    db = await createTestDb();
    cleanup = () => db.drop();
    const cases: [string, string][] = [
      ["HTTPS://Price.Example.DEV", "/"], ["https://h.com:443", ""], ["http://h.com:80/", "/v1"], ["https://h.com:8443", "/v1/"],
      ["http://h.com:443", "/a/b"], ["https://h.com/", "/V1"],
    ];
    let i = 0;
    for (const [origin, prefix] of cases) {
      await seedApi(db.sql, { id: `api_n${i}`, seller: `sel_n${i++}`, origin, prefix, state: "intake" });
    }
    const rows = await db.sql<{ origin: string; path_prefix: string; base_origin: string; base_path: string }[]>`
      select origin, path_prefix, base_origin, base_path from apis order by id`;
    for (const r of rows) {
      expect(r.base_origin).toBe(normalizeOrigin(r.origin));
      expect(r.base_path).toBe(normalizeBasePath(r.path_prefix));
    }
  });

  it("refuses a second active API on the same normalized base, but not before ownership, after retiring, or on /v10", async () => {
    db = await createTestDb();
    cleanup = () => db.drop();
    await seedApi(db.sql, { id: "api_a", seller: "sel_a", origin: "https://h.com", prefix: "/v1", state: "live" });
    await seedApi(db.sql, { id: "api_b", seller: "sel_b", origin: "https://H.com:443", prefix: "/v1/", state: "endpoints_confirmed" });
    await seedApi(db.sql, { id: "api_c", seller: "sel_c", origin: "https://h.com", prefix: "/v10", state: "live" });
    await expect(db.sql`update apis set state = 'ownership_verified' where id = 'api_b'`).rejects.toThrow(/apis_active_base_uniq/);
    await db.sql`update apis set state = 'retired' where id = 'api_a'`;
    await db.sql`update apis set state = 'ownership_verified' where id = 'api_b'`;
    await db.sql`delete from apis where id = 'api_b'`;
    await seedApi(db.sql, { id: "api_d", seller: "sel_d", origin: "https://h.com", prefix: "/v1", state: "live" });
  });
});
