import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { newId, ruleHash, type RuleDefinition } from "@hirakumi/core";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

type DemoOperation = {
  opId: string;
  method: string;
  path: string;
  description: string;
  sideEffectsLikely: boolean;
  inputSchema: Record<string, unknown>;
};

export const DEMO_OPERATIONS: DemoOperation[] = [
  { opId: "getPrice", method: "GET", path: "/price", description: "Returns the latest price for a symbol such as ADA.",
    sideEffectsLikely: false, inputSchema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" } } } },
  { opId: "getHistory", method: "GET", path: "/history", description: "Returns daily prices for a symbol.",
    sideEffectsLikely: false, inputSchema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" }, days: { type: "integer" } } } },
  { opId: "refreshCache", method: "POST", path: "/admin/refresh", description: "Clears and rebuilds the server cache.",
    sideEffectsLikely: true, inputSchema: { type: "object" } },
];

export const DEMO_PROMISE =
  'The response is JSON with a "symbol", a number "price", and a "last_updated" time no more than 5 minutes old.';

export function demoRule(apiId: string, opId: string): RuleDefinition {
  return {
    version: 1,
    status: { min: 200, max: 299 },
    contentType: "application/json",
    schema: {
      title: `${apiId}/${opId}`, // keeps rules.hash unique across APIs (contract note A7)
      type: "object",
      required: ["symbol", "price", "last_updated"],
      properties: { symbol: { type: "string" }, price: { type: "number" }, last_updated: { type: "string", maxAgeSeconds: 300 } },
    },
  };
}

async function setStep(tx: Tx, apiId: string, step: string, status: string, output: unknown = null): Promise<void> {
  await tx`
    insert into onboard_steps (api_id, step, status, attempts, output, updated_at)
    values (${apiId}, ${step}, ${status}, 1, ${JSON.stringify(output)}::jsonb, now())
    on conflict (api_id, step) do update
      set status = excluded.status, attempts = onboard_steps.attempts + 1, output = excluded.output, updated_at = now()`;
}

async function lockState(tx: Tx, apiId: string): Promise<string | null> {
  const [row] = await tx<{ state: string }[]>`select state from apis where id = ${apiId} for update`;
  return row?.state ?? null;
}

export async function fakeParse(sql: Sql, apiId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const state = await lockState(tx, apiId);
    if (state !== "intake" && state !== "parsed") throw new Error(`fakeParse needs state intake or parsed, got ${state ?? "missing"}`);
    for (const op of DEMO_OPERATIONS) {
      await tx`
        insert into operations (id, api_id, op_id, method, path, input_schema, description, side_effects_likely)
        values (${newId("op")}, ${apiId}, ${op.opId}, ${op.method}, ${op.path}, ${JSON.stringify(op.inputSchema)}::jsonb,
                ${op.description}, ${op.sideEffectsLikely})
        on conflict (api_id, op_id) do nothing`;
    }
    await setStep(tx, apiId, "parse", "done", { operations: DEMO_OPERATIONS.length });
    await setStep(tx, apiId, "describe", "done");
    await tx`update apis set state = 'described' where id = ${apiId}`;
  });
}

export async function fakeBuildRules(sql: Sql, apiId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const state = await lockState(tx, apiId);
    if (state !== "ownership_verified") throw new Error(`fakeBuildRules needs state ownership_verified, got ${state ?? "missing"}`);
    const ops = await tx<{ id: string; opId: string }[]>`
      select id, op_id as "opId" from operations where api_id = ${apiId} and enabled`;
    if (ops.length === 0) throw new Error("fakeBuildRules found no enabled operations");
    for (const op of ops) {
      const def = demoRule(apiId, op.opId);
      await tx`
        insert into rules (id, operation_id, version, definition, hash, plain_english)
        values (${newId("rule")}, ${op.id}, 1, ${JSON.stringify(def)}::jsonb, ${ruleHash(def)}, ${DEMO_PROMISE})
        on conflict (operation_id, version) do nothing`;
    }
    await setStep(tx, apiId, "qa", "done", { testCalls: 5 });
    await tx`update apis set state = 'rule_built' where id = ${apiId}`;
  });
}

export async function fakeGoLive(sql: Sql, apiId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const state = await lockState(tx, apiId);
    if (state !== "registering") throw new Error(`fakeGoLive needs state registering, got ${state ?? "missing"}`);
    await tx`
      update apis set state = 'live', agent_identifier = coalesce(agent_identifier, ${`demo_${apiId}`}),
        health = 'healthy', health_checked_at = now()
      where id = ${apiId}`;
    await setStep(tx, apiId, "register", "done");
  });
}

export async function fakeFail(sql: Sql, apiId: string, step: string, error: string): Promise<void> {
  await sql.begin(async (tx) => {
    await setStep(tx, apiId, step, "failed", { error });
  });
}

async function main(): Promise<void> {
  const [cmd, apiId, ...rest] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`dev-coworker only runs against a local database, not ${host}`);
  if (!cmd || !apiId) {
    console.error("usage: dev-coworker <parse|build-rules|go-live|fail> <apiId> [step] [message]");
    process.exit(2);
  }
  const sql = postgres(url, { max: 1 });
  try {
    if (cmd === "parse") await fakeParse(sql, apiId);
    else if (cmd === "build-rules") await fakeBuildRules(sql, apiId);
    else if (cmd === "go-live") await fakeGoLive(sql, apiId);
    else if (cmd === "fail") {
      await fakeFail(sql, apiId, rest[0] ?? "parse",
        rest.slice(1).join(" ") || "This looks like Swagger 2.0. Hirakumi needs an OpenAPI 3.x description.");
    } else throw new Error(`unknown command ${cmd}`);
    console.log(`${cmd} done for ${apiId}`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
