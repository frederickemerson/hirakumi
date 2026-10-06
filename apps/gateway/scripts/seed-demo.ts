import { inferRule, newId, ruleHash, safeFetch } from "@hirakumi/core";
import { createDb, migrate } from "@hirakumi/db";

const [origin, path, queryJson = "{}", opId = "getPrice"] = process.argv.slice(2);
if (!origin || !path) {
  console.error("usage: tsx scripts/seed-demo.ts <origin> <path> [queryJSON] [opId]");
  process.exit(1);
}
const payTo = process.env.SELLER_DEMO_ADDRESS?.trim() ?? "";
const dbUrl = process.env.DATABASE_URL?.trim() ?? "";
if (!payTo.startsWith("addr_test1") || !dbUrl) {
  console.error("Set SELLER_DEMO_ADDRESS (addr_test1…) and DATABASE_URL");
  process.exit(1);
}
const query = JSON.parse(queryJson) as Record<string, string>;
const url = new URL(path, origin);
for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

const samples: unknown[] = [];
for (let i = 0; i < 5; i++) {
  const r = await safeFetch(url.toString(), { method: "GET", headers: { accept: "application/json" } });
  if (r.status !== 200) {
    console.error(`sample ${i + 1}: HTTP ${r.status} ${r.body.slice(0, 200)}`);
    process.exit(1);
  }
  samples.push(JSON.parse(r.body));
}
const definition = inferRule(samples);
const hash = ruleHash(definition);
const inputSchema = {
  type: "object",
  properties: Object.fromEntries(Object.keys(query).map((k) => [k, { type: "string" }])),
  required: Object.keys(query),
  additionalProperties: false,
};

const sql = createDb(dbUrl, { max: 1 });
await migrate(sql);
const [existing] = await sql<{ api_id: string }[]>`select o.api_id from rules r join operations o on o.id = r.operation_id where r.hash = ${hash}`;
if (existing) {
  console.log(`Already seeded with this promise: api ${existing.api_id}`);
  await sql.end();
  process.exit(0);
}
const [seller] = await sql<{ id: string }[]>`
  insert into sellers (id, cardano_addr) values (${newId("sel")}, ${payTo})
  on conflict (cardano_addr) do update set cardano_addr = excluded.cardano_addr returning id`;
const apiId = newId("api"), operationId = newId("op"), packId = newId("pk");
await sql`
  insert into apis (id, seller_id, name, origin, openapi_url, state, health, escrow_op_id)
  values (${apiId}, ${seller.id}, 'Demo Price API', ${url.origin}, ${`${url.origin}/openapi.json`}, 'live', 'healthy', ${operationId})`;
await sql`
  insert into operations (id, api_id, op_id, method, path, input_schema, enabled, side_effects_confirmed_none, description)
  values (${operationId}, ${apiId}, ${opId}, 'GET', ${url.pathname}, ${sql.json(inputSchema)}, true, true, 'Seeded by hand for the hour-10 checkpoint')`;
await sql`
  insert into rules (id, operation_id, version, definition, hash, plain_english)
  values (${newId("rule")}, ${operationId}, 1, ${sql.json(definition as never)}, ${hash}, 'Inferred from 5 live samples.')`;
await sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values (${packId}, ${apiId}, 100, 2000000, 1000000)`;
await sql`insert into test_inputs (id, operation_id, input) values (${newId("ti")}, ${operationId}, ${sql.json(query)})`;
await sql.end();

const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? "http://localhost:4021";
const qs = new URLSearchParams(query).toString();
console.log(JSON.stringify({ apiId, opId, packId, ruleHash: hash }, null, 2));
console.log(`\nOperation: ${base}/a/${apiId}/x/${opId}${qs ? `?${qs}` : ""}`);
console.log(`Pack:      ${base}/a/${apiId}/packs/${packId}`);
console.log(`Promise:   ${base}/r/${hash}`);
