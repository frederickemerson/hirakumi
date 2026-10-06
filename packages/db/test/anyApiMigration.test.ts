import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Sql } from "../src/client";
import { migrate, MIGRATIONS_DIR } from "../src/migrate";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";
const MIGRATION = "0014_any_api_samples.sql";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** A schema migrated only up to (not including) `stopBefore`, so data can be seeded the way production has it. */
async function schemaBefore(stopBefore: string): Promise<Sql> {
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
  return sql;
}

const code = () => `hkv_${randomBytes(32).toString("base64url")}`;
const challenge = (sql: Sql, id: string, apiId: string, kind: string, token: string, consumed = false) => sql`
  insert into challenges (id, api_id, kind, token, expires_at, consumed_at)
  values (${id}, ${apiId}, ${kind}, ${token}, now() + interval '1 year', ${consumed ? new Date() : null})`;

describe(`migration ${MIGRATION}`, () => {
  it("keeps existing APIs and old codes, allows a samples API without openapi_url, and adds the header codes", async () => {
    const sql = await schemaBefore(MIGRATION);
    await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1sel_a'), ('sel_b', 'addr_test1sel_b')`;
    await sql`
      insert into apis (id, seller_id, name, origin, path_prefix, openapi_url, state)
      values ('api_old', 'sel_a', 'Old', 'https://h.com', '/v1', 'https://h.com/v1/openapi.json', 'live'),
             ('api_wip', 'sel_b', 'Wip', 'https://h.com', '/v2', 'https://h.com/v2/openapi.json', 'endpoints_confirmed')`;
    const oldCode = code();
    await challenge(sql, "ch_old", "api_wip", "openapi", oldCode);

    expect((await migrate(sql))[0]).toBe(MIGRATION); // later migrations may follow

    expect(await sql`select id, intake_kind, samples, openapi_url from apis order by id`).toEqual([
      { id: "api_old", intake_kind: "openapi", samples: null, openapi_url: "https://h.com/v1/openapi.json" },
      { id: "api_wip", intake_kind: "openapi", samples: null, openapi_url: "https://h.com/v2/openapi.json" },
    ]);
    expect(await sql`select id, kind, token from challenges`).toEqual([{ id: "ch_old", kind: "openapi", token: oldCode }]);

    // A samples API has no OpenAPI link.
    await sql`
      insert into apis (id, seller_id, name, origin, path_prefix, openapi_url, intake_kind, samples)
      values ('api_s', 'sel_a', 'S', 'https://s.com', '/v1', null, 'samples', ${sql.json({ base: "https://s.com/v1", lines: "GET /p?a=1" })})`;
    // samples API <=> samples set, and an OpenAPI API keeps its link.
    await expect(sql`insert into apis (id, seller_id, name, origin, openapi_url, intake_kind) values ('api_x1', 'sel_a', 'X', 'https://x.com', null, 'samples')`)
      .rejects.toThrow(/apis_samples_match_kind/);
    await expect(sql`insert into apis (id, seller_id, name, origin, openapi_url, samples) values ('api_x2', 'sel_a', 'X', 'https://x.com', 'https://x.com/openapi.json', ${sql.json({ base: "https://x.com" })})`)
      .rejects.toThrow(/apis_samples_match_kind/);
    await expect(sql`insert into apis (id, seller_id, name, origin, openapi_url) values ('api_x3', 'sel_a', 'X', 'https://x.com', null)`)
      .rejects.toThrow(/apis_openapi_url_for_openapi/);

    // Header codes: allowed next to the old open 'openapi' code, one open per API, never reused.
    const h1 = code();
    await challenge(sql, "ch_h1", "api_wip", "header", h1);
    await expect(challenge(sql, "ch_h2", "api_wip", "header", code())).rejects.toThrow(/challenges_header_open_per_api/);
    await expect(challenge(sql, "ch_h3", "api_s", "header", h1)).rejects.toThrow(/challenges_header_token_uniq/);
    await expect(challenge(sql, "ch_h4", "api_s", "header", h1, true)).rejects.toThrow(/challenges_header_token_uniq/);
    await challenge(sql, "ch_h5", "api_wip", "header", code(), true); // a consumed code does not block
    await challenge(sql, "ch_h6", "api_s", "header", code());
    await expect(challenge(sql, "ch_bad", "api_s", "dns", code())).rejects.toThrow(/challenges_kind_check/);
  }, 30_000); // replays every migration; slow under a parallel workspace run
});
