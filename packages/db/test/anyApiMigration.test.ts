import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Sql } from "../src/client";
import { migrate, MIGRATIONS_DIR } from "../src/migrate";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";
const ANY_API = "0014_any_api_samples.sql";
const HEADER_VERIFY = "0015_header_verify.sql";
const DNS_VERIFY = "0018_dns_verify.sql";
/** Later migrations replay after these; they don't change what this file checks. */
const LATER = ["0016_seller_self_test.sql", "0017_auth_sessions.sql", "0018_dns_verify.sql", "0019_exposure.sql"];
/** sha256 of 0014 as PR #5 shipped it. A database may already have run that file, so it never changes again. */
const ANY_API_SHA256 = "e5e3525fded53467041b8bc0191b57409e3d319bea607484c324d741303df3b7";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function freshSchema(): Promise<Sql> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = createDb(TEST_URL, { max: 1 });
  await admin.unsafe(`create schema ${schema}`);
  await admin.end();
  const sql = createDb(TEST_URL, { searchPath: schema, max: 2 });
  cleanups.push(async () => {
    await sql.end();
    const a = createDb(TEST_URL, { max: 1 });
    await a.unsafe(`drop schema if exists ${schema} cascade`);
    await a.end();
  });
  return sql;
}

/** A schema migrated only up to (not including) `stopBefore`, so data can be seeded the way a database has it. */
async function schemaBefore(stopBefore: string): Promise<Sql> {
  const sql = await freshSchema();
  const older = await mkdtemp(join(tmpdir(), "mig-"));
  for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql") && f < stopBefore)) {
    await copyFile(join(MIGRATIONS_DIR, f), join(older, f));
  }
  await migrate(sql, older);
  return sql;
}

const code = () => `hkv_${randomBytes(32).toString("base64url")}`;
const challenge = (sql: Sql, id: string, apiId: string, kind: string, token: string, consumed = false) => sql`
  insert into challenges (id, api_id, kind, token, expires_at, consumed_at)
  values (${id}, ${apiId}, ${kind}, ${token}, now() + interval '1 year', ${consumed ? new Date() : null})`;

describe(`migration ${ANY_API}`, () => {
  it("is the file PR #5 shipped, byte for byte", async () => {
    const text = await readFile(join(MIGRATIONS_DIR, ANY_API));
    expect(createHash("sha256").update(text).digest("hex")).toBe(ANY_API_SHA256);
  });

  it("keeps existing APIs and old codes on a 0013 database", async () => {
    const sql = await schemaBefore(ANY_API);
    await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1sel_a')`;
    await sql`
      insert into apis (id, seller_id, name, origin, path_prefix, openapi_url, state)
      values ('api_old', 'sel_a', 'Old', 'https://h.com', '/v1', 'https://h.com/v1/openapi.json', 'live')`;
    const oldCode = code();
    await challenge(sql, "ch_old", "api_old", "openapi", oldCode);

    expect(await migrate(sql)).toEqual([ANY_API, HEADER_VERIFY, ...LATER]);

    expect(await sql`select id, intake_kind, samples, openapi_url from apis`).toEqual([
      { id: "api_old", intake_kind: "openapi", samples: null, openapi_url: "https://h.com/v1/openapi.json" },
    ]);
    expect(await sql`select id, kind, token from challenges`).toEqual([{ id: "ch_old", kind: "openapi", token: oldCode }]);
  }, 30_000); // replays every migration; slow under a parallel workspace run
});

describe(`migration ${HEADER_VERIFY}`, () => {
  it("replays 0001 to 0015 on an empty database", async () => {
    const sql = await freshSchema();
    const applied = await migrate(sql);
    expect(applied.slice(-2 - LATER.length)).toEqual([ANY_API, HEADER_VERIFY, ...LATER]);
    expect(applied).toEqual([...applied].sort());
    expect(await migrate(sql)).toEqual([]);
  }, 30_000);

  it("runs on a database that already has PR #5's 0014, and the header codes work", async () => {
    const sql = await schemaBefore(HEADER_VERIFY);
    await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1sel_a'), ('sel_b', 'addr_test1sel_b')`;
    // Rows as PR #5 wrote them: a samples API's openapi_url was its proof file.
    await sql`
      insert into apis (id, seller_id, name, origin, path_prefix, openapi_url, state, intake_kind, samples)
      values ('api_old', 'sel_a', 'Old', 'https://h.com', '/v1', 'https://h.com/v1/openapi.json', 'live', 'openapi', null),
             ('api_s5', 'sel_b', 'S5', 'https://s.com', '/v1', 'https://s.com/v1/hirakumi-verify.json', 'endpoints_confirmed',
              'samples', ${sql.json({ base: "https://s.com/v1", lines: "GET /p?a=1" })})`;
    const oldCode = code();
    await challenge(sql, "ch_old", "api_s5", "openapi", oldCode);

    expect(await migrate(sql)).toEqual([HEADER_VERIFY, ...LATER]);

    expect(await sql`select id, intake_kind, openapi_url from apis order by id`).toEqual([
      { id: "api_old", intake_kind: "openapi", openapi_url: "https://h.com/v1/openapi.json" },
      { id: "api_s5", intake_kind: "samples", openapi_url: null }, // the proof file is no longer used
    ]);
    expect(await sql`select id, kind, token from challenges`).toEqual([{ id: "ch_old", kind: "openapi", token: oldCode }]);

    // A samples API has no OpenAPI link; samples API <=> samples set; an OpenAPI API keeps its link.
    await sql`
      insert into apis (id, seller_id, name, origin, path_prefix, openapi_url, intake_kind, samples)
      values ('api_s', 'sel_a', 'S', 'https://t.com', '/v1', null, 'samples', ${sql.json({ base: "https://t.com/v1", lines: "GET /p?a=1" })})`;
    await expect(sql`insert into apis (id, seller_id, name, origin, openapi_url, intake_kind) values ('api_x1', 'sel_a', 'X', 'https://x.com', null, 'samples')`)
      .rejects.toThrow(/apis_samples_match_kind/);
    await expect(sql`insert into apis (id, seller_id, name, origin, openapi_url) values ('api_x3', 'sel_a', 'X', 'https://x.com', null)`)
      .rejects.toThrow(/apis_openapi_url_for_openapi/);

    // Header codes: allowed next to the old open 'openapi' code, one open per API, never reused.
    const h1 = code();
    await challenge(sql, "ch_h1", "api_s5", "header", h1);
    await expect(challenge(sql, "ch_h2", "api_s5", "header", code())).rejects.toThrow(/challenges_header_open_per_api/);
    await expect(challenge(sql, "ch_h3", "api_s", "header", h1)).rejects.toThrow(/challenges_header_token_uniq/);
    await expect(challenge(sql, "ch_h4", "api_s", "header", h1, true)).rejects.toThrow(/challenges_header_token_uniq/);
    await challenge(sql, "ch_h5", "api_s5", "header", code(), true); // a consumed code does not block
    await challenge(sql, "ch_h6", "api_s", "header", code());
    await expect(challenge(sql, "ch_bad", "api_s", "nope", code())).rejects.toThrow(/challenges_kind_check/);
  }, 30_000);

  it("can run again on a database that already has it (or had its changes in an earlier 0014)", async () => {
    const sql = await freshSchema();
    await migrate(sql);
    await sql.unsafe(await readFile(join(MIGRATIONS_DIR, HEADER_VERIFY), "utf8"));
    const kinds = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'challenges_kind_check' and conrelid = 'challenges'::regclass`;
    expect(kinds).toHaveLength(1);
    expect(kinds[0].def).toContain("'header'");
    const indexes = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = current_schema() and indexname like 'challenges_header_%' order by indexname`;
    expect(indexes.map((i) => i.indexname)).toEqual(["challenges_header_open_per_api", "challenges_header_token_uniq"]);
  }, 30_000);
});

describe(`migration ${DNS_VERIFY}`, () => {
  it("turns an open header code into a dns code (same code, no pass), and leaves proven header codes alone", async () => {
    const sql = await schemaBefore(DNS_VERIFY);
    await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1sel_a')`;
    await sql`
      insert into apis (id, seller_id, name, origin, path_prefix, openapi_url, state)
      values ('api_mid', 'sel_a', 'Mid', 'https://m.com', '/a', 'https://m.com/openapi.json', 'endpoints_confirmed'),
             ('api_live', 'sel_a', 'Live', 'https://l.com', '/b', 'https://l.com/openapi.json', 'live')`;
    const open = code();
    const proven = code();
    await challenge(sql, "ch_open", "api_mid", "header", open);
    await sql`update challenges set proof = ${sql.json({ passedAt: new Date().toISOString() })} where id = 'ch_open'`;
    await challenge(sql, "ch_proven", "api_live", "header", proven, true);

    expect(await migrate(sql)).toEqual(LATER.slice(LATER.indexOf(DNS_VERIFY)));
    expect(await sql`select id, kind, token, proof from challenges order by id`).toEqual([
      { id: "ch_open", kind: "dns", token: open, proof: null },
      { id: "ch_proven", kind: "header", token: proven, proof: null },
    ]);

    // dns codes: one open per API, never reused.
    await expect(challenge(sql, "ch_d2", "api_mid", "dns", code())).rejects.toThrow(/challenges_dns_open_per_api/);
    await expect(challenge(sql, "ch_d3", "api_live", "dns", open, true)).rejects.toThrow(/challenges_dns_token_uniq/);
    await challenge(sql, "ch_d4", "api_mid", "dns", code(), true); // a consumed code does not block
  }, 30_000);

  it("can run again", async () => {
    const sql = await freshSchema();
    await migrate(sql);
    await sql.unsafe(await readFile(join(MIGRATIONS_DIR, DNS_VERIFY), "utf8"));
    const [kinds] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'challenges_kind_check' and conrelid = 'challenges'::regclass`;
    expect(kinds.def).toContain("'dns'");
    expect(kinds.def).toContain("'header'");
  }, 30_000);
});
