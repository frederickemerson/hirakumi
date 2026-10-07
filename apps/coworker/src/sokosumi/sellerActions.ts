import {
  addRequiredPhraseTx, isStatusOnlyRule, newId, newVerifyCode, RuleInferenceError, VERIFY_PASS_TTL_MINUTES, type RuleDefinition,
} from "@hirakumi/core";
import type pg from "pg";
import type { Db } from "../db.js";
import type { AuthHint } from "../openapi/parse.js";
import { withTx } from "../db.js";
import { formatTusdm, MIN_PRICE_MICROS, SUGGESTED_PACK, tusdmToMicros } from "./replies.js";

/**
 * The non-wallet seller actions a Sokosumi reply may take, with the same rules as the web routes they mirror
 * (apps/web/lib/repo/operations.ts confirmEndpoints, apps/web/lib/repo/packs.ts savePricing). Publishing is not here:
 * it needs the seller's wallet.
 */

/**
 * intakeKind: 'openapi' (the seller gave an OpenAPI link) or 'samples' (a base URL and example requests).
 * failedStep: the step that failed for good, when `failed`.
 */
export type TaskApi = {
  id: string; name: string; state: string; origin: string; pathPrefix: string; failed: boolean; failedStep: string | null; intakeKind: "openapi" | "samples";
};
export type ListedOp = { ref: string; id: string; opId: string; method: string; path: string; description: string | null; sideEffectsLikely: boolean };
export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

/** The task's API: the newest one that isn't retired. `failed` = a step failed for good (a new link may restart). */
export async function apiForTask(db: Db, taskId: string): Promise<TaskApi | null> {
  const { rows } = await db.query<TaskApi>(
    `select id, name, state, origin, path_prefix as "pathPrefix", intake_kind as "intakeKind",
            exists (select 1 from onboard_steps s where s.api_id = apis.id and s.status = 'failed') as failed,
            (select s.step from onboard_steps s where s.api_id = apis.id and s.status = 'failed' order by s.updated_at desc limit 1) as "failedStep"
     from apis where sokosumi_task_id = $1 and state <> 'retired' order by created_at desc limit 1`,
    [taskId],
  );
  return rows[0] ?? null;
}

/** Endpoints in a stable order, numbered from 1: the numbers the seller replies with. */
export async function listOps(db: Db, apiId: string): Promise<ListedOp[]> {
  const { rows } = await db.query<{ id: string; op_id: string; method: string; path: string; description: string | null; side_effects_likely: boolean }>(
    `select id, op_id, method, path, description, side_effects_likely from operations where api_id = $1
     order by path collate "C", method collate "C", op_id collate "C"`,
    [apiId],
  );
  return rows.map((r, i) => ({
    ref: String(i + 1), id: r.id, opId: r.op_id, method: r.method.toUpperCase(), path: r.path,
    description: r.description, sideEffectsLikely: r.side_effects_likely,
  }));
}

/** Same rule as the web (apps/web/lib/endpoints.ts): anything but a GET, or a GET that looks like it writes. */
export const needsReadOnlyConfirmation = (op: Pick<ListedOp, "method" | "sideEffectsLikely">) => op.method !== "GET" || op.sideEffectsLikely;

export function opLine(op: ListedOp): string {
  return `${op.ref}. ${op.method} ${op.path} (${op.opId})${op.description ? `: ${op.description}` : ""}${needsReadOnlyConfirmation(op) ? " [may change data]" : ""}`;
}

/** described / endpoints_confirmed → endpoints_confirmed. The first endpoint named runs per-job (escrow) hires. */
export async function confirmSell(pool: pg.Pool, apiId: string, refs: string[], readOnlyConfirmed: boolean): Promise<ActionResult> {
  return withTx(pool, async (c): Promise<ActionResult> => {
    const { rows: [api] } = await c.query<{ state: string }>(`select state from apis where id = $1 for update`, [apiId]);
    if (!api) return { ok: false, error: "I couldn't find that API any more." };
    if (api.state !== "described" && api.state !== "endpoints_confirmed") {
      return { ok: false, error: "Endpoints can only be chosen after I've described them and before you prove ownership." };
    }
    const ops = await listOps(c, apiId);
    const chosen: ListedOp[] = [];
    for (const ref of refs) {
      const op = ops.find((o) => o.ref === ref || o.opId === ref);
      if (!op) return { ok: false, error: `There is no endpoint "${ref}". Use the numbers from my list (1 to ${ops.length}).` };
      if (!chosen.includes(op)) chosen.push(op);
    }
    if (chosen.length === 0) return { ok: false, error: "Choose at least one endpoint to sell." };
    const unconfirmed = chosen.filter(needsReadOnlyConfirmation);
    if (unconfirmed.length && !readOnlyConfirmed) {
      return {
        ok: false,
        error: `${unconfirmed.map((o) => `${o.method} ${o.path}`).join(", ")} may change data. If it changes nothing on your server, reply again with \`readonly\` at the end (\`sell ${refs.join(" ")} readonly\`); otherwise don't sell it.`,
      };
    }
    const enabled = new Set(chosen.map((o) => o.id));
    for (const op of ops) {
      await c.query(`update operations set enabled = $2, side_effects_confirmed_none = $3 where id = $1`, [
        op.id, enabled.has(op.id), enabled.has(op.id) && (readOnlyConfirmed || !needsReadOnlyConfirmation(op)),
      ]);
    }
    await c.query(`update apis set escrow_op_id = $2, state = 'endpoints_confirmed' where id = $1`, [apiId, chosen[0].opId]);
    return {
      ok: true,
      message: `Selling ${chosen.map((o) => `${o.method} ${o.path}`).join(", ")}. Per-job hires (Masumi escrow) run ${chosen[0].opId}.`,
    };
  });
}

/** rule_built / priced → priced. Keeps the pack size and per-job price unless the reply sets them. */
export async function savePrice(pool: pg.Pool, apiId: string, priceText: string, calls: number | null): Promise<ActionResult> {
  const priceMicros = tusdmToMicros(priceText);
  if (priceMicros < MIN_PRICE_MICROS) return { ok: false, error: "A pack must cost at least 1 tUSDM. Cardano can't move smaller token payments cheaply." };
  if (calls !== null && (calls < 1 || calls > 100_000)) return { ok: false, error: "Pack size must be between 1 and 100,000 calls." };
  return withTx(pool, async (c): Promise<ActionResult> => {
    const { rows: [api] } = await c.query<{ state: string }>(`select state from apis where id = $1 for update`, [apiId]);
    if (!api) return { ok: false, error: "I couldn't find that API any more." };
    if (api.state !== "rule_built" && api.state !== "priced") {
      return { ok: false, error: "Prices can only be set after the test calls and before publishing." };
    }
    const { rows: [missing] } = await c.query<{ count: number }>(
      `select count(*)::int as count from operations o where o.api_id = $1 and o.enabled and not exists (select 1 from rules r where r.operation_id = o.id)`,
      [apiId],
    );
    if (missing.count > 0) return { ok: false, error: "The test calls haven't finished for every endpoint yet. Try again in a minute." };
    const { rows: [pack] } = await c.query<{ id: string; calls: number; escrow_price_micros: string }>(
      `select id, calls, escrow_price_micros::text from packs where api_id = $1 order by id limit 1`,
      [apiId],
    );
    const packCalls = calls ?? pack?.calls ?? SUGGESTED_PACK.calls;
    // Escrow packs pay per call: the price must split evenly across the calls (the gateway won't offer it otherwise).
    if (priceMicros % BigInt(packCalls) !== 0n) {
      return { ok: false, error: `The pack price must split evenly across its ${packCalls} calls, because escrow pays you per call. Try a round price such as ${formatTusdm(((priceMicros + BigInt(packCalls) - 1n) / BigInt(packCalls)) * BigInt(packCalls))} tUSDM.` };
    }
    if (pack) {
      await c.query(`update packs set calls = $2, price_micros = $3::bigint where api_id = $1`, [apiId, packCalls, priceMicros.toString()]);
    } else {
      await c.query(
        `insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values ($1, $2, $3, $4::bigint, $5::bigint)`,
        [newId("pk"), apiId, packCalls, priceMicros.toString(), SUGGESTED_PACK.escrowPriceMicros.toString()],
      );
    }
    await c.query(`update apis set state = 'priced' where id = $1`, [apiId]);
    const escrow = pack ? BigInt(pack.escrow_price_micros) : SUGGESTED_PACK.escrowPriceMicros;
    return { ok: true, message: `Price saved: ${priceText} tUSDM for ${packCalls} calls, and ${formatTusdm(escrow)} tUSDM per escrow job.` };
  });
}

/**
 * The enabled operations whose latest promise is status-only (core isStatusOnlyRule): publishing is refused until the
 * seller adds a phrase every good answer contains on the review page.
 */
export async function opsNeedingPhrase(db: Db, apiId: string): Promise<string[]> {
  const { rows } = await db.query<{ op_id: string; definition: RuleDefinition }>(
    `select distinct on (o.id) o.op_id, r.definition from operations o join rules r on r.operation_id = o.id
     where o.api_id = $1 and o.enabled order by o.id, r.version desc`,
    [apiId],
  );
  return rows.filter((r) => r.definition?.schema && isStatusOnlyRule(r.definition)).map((r) => r.op_id).sort();
}

/** The seller already linked this Sokosumi account to a wallet (a setup link they signed in with). Exactly one, or null. */
export async function linkedSeller(db: Db, sokosumiUserId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(`select id from sellers where sokosumi_user_id = $1 limit 2`, [sokosumiUserId]);
  return rows.length === 1 ? rows[0].id : null;
}

/** The wallet this Sokosumi account is linked to (linkedSeller's cardano_addr), or null when it is not linked. */
export async function linkedWallet(db: Db, sokosumiUserId: string): Promise<string | null> {
  const sellerId = await linkedSeller(db, sokosumiUserId);
  if (!sellerId) return null;
  const { rows } = await db.query<{ cardano_addr: string }>(`select cardano_addr from sellers where id = $1`, [sellerId]);
  return rows[0]?.cardano_addr ?? null;
}

/** How a comment names a wallet: its last 6 characters, as a Markdown code span. */
export const walletTail = (addr: string) => `\`…${addr.slice(-6)}\``;

/**
 * Creates the task's API for a linked seller; the driver then reads and describes it. With samples (any API, no
 * OpenAPI file), openapiUrl is null. origin is a placeholder until the parse step reads servers[0].
 */
export async function createTaskApi(
  db: Db,
  a: { sellerId: string; taskId: string; name: string; origin: string; openapiUrl: string | null; samples?: { base: string; lines: string } },
): Promise<string> {
  const id = newId("api");
  await db.query(
    `insert into apis (id, seller_id, name, origin, openapi_url, sokosumi_task_id, intake_kind, samples) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [id, a.sellerId, a.name.slice(0, 80), a.origin, a.openapiUrl, a.taskId, a.samples ? "samples" : "openapi", a.samples ? JSON.stringify(a.samples) : null],
  );
  return id;
}

/** Where the API's key goes (the parse step's authHint), or null when it needs none or was not read yet. */
export async function apiAuthHint(db: Db, apiId: string): Promise<AuthHint | null> {
  const { rows } = await db.query<{ hint: AuthHint | null }>(
    `select output->'authHint' as hint from onboard_steps where api_id = $1 and step = 'parse'`, [apiId]);
  const h = rows[0]?.hint;
  return h && typeof h === "object" && (h.in === "header" || h.in === "query") && typeof h.name === "string" ? h : null;
}

/**
 * This API's open ownership code (challenges kind 'dns'), created when the seller hasn't opened the ownership page
 * yet, so the task comment can give the exact DNS record. Same rows, lock key and uniqueness as the web app
 * (apps/web/lib/repo/challenges.ts getOrCreateVerifyCode), so the comment and the page always show one code.
 */
export async function ensureVerifyCode(db: pg.Pool, apiId: string): Promise<string> {
  return withTx(db, async (c) => {
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [`dns-verify|${apiId}`]);
    const { rows } = await c.query<{ token: string }>(
      "select token from challenges where api_id = $1 and kind = 'dns' and consumed_at is null limit 1", [apiId]);
    if (rows[0]) return rows[0].token;
    const token = newVerifyCode();
    await c.query(
      "insert into challenges (id, api_id, kind, token, expires_at) values ($1, $2, 'dns', $3, now() + interval '10 years')",
      [newId("ch"), apiId, token]);
    return token;
  });
}

/**
 * `phrase Price` (or `phrase 2 Price` for endpoint 2): a phrase every good answer must contain, added to a text
 * promise with the web review page's rule (@hirakumi/core addRequiredPhraseTx). Without an endpoint named, it goes to
 * the one endpoint that needs a phrase, or the only endpoint on sale. Quotes around the phrase are dropped.
 */
export async function addPhrase(pool: pg.Pool, apiId: string, text: string): Promise<ActionResult> {
  // Numbered as in the endpoint list (listOps), so `phrase 2 …` means the endpoint the seller chose as 2.
  const { rows: enabled } = await pool.query<{ id: string }>(`select id from operations where api_id = $1 and enabled`, [apiId]);
  const on = (await listOps(pool, apiId)).filter((o) => enabled.some((e) => e.id === o.id));
  const [first, ...rest] = text.split(/\s+/);
  const named = rest.length ? on.find((o) => o.ref === first || o.opId === first) : undefined;
  const needing = await opsNeedingPhrase(pool, apiId);
  const target = named
    ?? (needing.length === 1 ? on.find((o) => o.opId === needing[0]) : on.length === 1 ? on[0] : undefined);
  if (!target) {
    const list = (needing.length ? on.filter((o) => needing.includes(o.opId)) : on).map((o) => `${o.ref} (${o.method} ${o.path})`).join(", ");
    return { ok: false, error: `Name the endpoint first, like \`phrase 1 Price\`. Endpoints: ${list}.` };
  }
  const phrase = (named ? rest.join(" ") : text).trim().replace(/^["'\u201c\u2018](.*)["'\u201d\u2019]$/, "$1").trim();
  try {
    const r = await withTx(pool, (c) => addRequiredPhraseTx((q, p) => c.query(q, p).then((x) => x.rows), { apiId, operationId: target.id, phrase }));
    if (!r.ok) {
      return { ok: false, error: r.reason === "locked" ? "Your promise is published, so it can't change any more." : "I couldn't find that endpoint's promise." };
    }
    return { ok: true, message: `Saved. Every good answer from ${target.method} ${target.path} must contain "${phrase}". The promise now reads: ${r.plainEnglish}` };
  } catch (e) {
    if (e instanceof RuleInferenceError) return { ok: false, error: e.message };
    throw e;
  }
}

/** The phrase QA suggested for each operation (onboard_steps(step='qa').output.suggestedPhrases), by op id. */
export async function suggestedPhrases(db: Db, apiId: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ s: unknown }>(`select output->'suggestedPhrases' as s from onboard_steps where api_id = $1 and step = 'qa'`, [apiId]);
  const s = rows[0]?.s;
  if (!s || typeof s !== "object" || Array.isArray(s)) return {};
  return Object.fromEntries(Object.entries(s).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** The saved pack: price and calls, or null before a price was set. */
export async function savedPack(db: Db, apiId: string): Promise<{ priceMicros: string; calls: number } | null> {
  const { rows } = await db.query<{ price_micros: string; calls: number }>(
    `select price_micros::text, calls from packs where api_id = $1 order by id limit 1`, [apiId]);
  return rows[0] ? { priceMicros: rows[0].price_micros, calls: rows[0].calls } : null;
}

/** The API's DNS record passed the ownership check in the last 30 minutes (onboarding/dnsWatch.ts records it). */
export async function hasFreshDnsPass(db: Db, apiId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from challenges where api_id = $1 and kind = 'dns' and consumed_at is null
       and (proof->>'passedAt')::timestamptz > now() - make_interval(mins => $2)`,
    [apiId, VERIFY_PASS_TTL_MINUTES]);
  return rows.length > 0;
}
