import { newId } from "@hirakumi/core";
import type pg from "pg";
import type { Db } from "../db.js";
import { withTx } from "../db.js";
import { formatTusdm, MIN_PRICE_MICROS, SUGGESTED_PACK, tusdmToMicros } from "./replies.js";

/**
 * The non-wallet seller actions a Sokosumi reply may take, with the same rules as the web routes they mirror
 * (apps/web/lib/repo/operations.ts confirmEndpoints, apps/web/lib/repo/packs.ts savePricing). Publishing is not here:
 * it needs the seller's wallet.
 */

export type TaskApi = { id: string; name: string; state: string; origin: string; failed: boolean };
export type ListedOp = { ref: string; id: string; opId: string; method: string; path: string; description: string | null; sideEffectsLikely: boolean };
export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

/** The task's API: the newest one that isn't retired. `failed` = a step failed for good (a new link may restart). */
export async function apiForTask(db: Db, taskId: string): Promise<TaskApi | null> {
  const { rows } = await db.query<TaskApi>(
    `select id, name, state, origin,
            exists (select 1 from onboard_steps s where s.api_id = apis.id and s.status = 'failed') as failed
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

/** The seller already linked this Sokosumi account to a wallet (a setup link they signed in with). Exactly one, or null. */
export async function linkedSeller(db: Db, sokosumiUserId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(`select id from sellers where sokosumi_user_id = $1 limit 2`, [sokosumiUserId]);
  return rows.length === 1 ? rows[0].id : null;
}

/** Creates the task's API for a linked seller; the driver then reads and describes it. */
export async function createTaskApi(db: Db, a: { sellerId: string; taskId: string; name: string; origin: string; openapiUrl: string }): Promise<string> {
  const id = newId("api");
  await db.query(
    `insert into apis (id, seller_id, name, origin, openapi_url, sokosumi_task_id) values ($1, $2, $3, $4, $5, $6)`,
    [id, a.sellerId, a.name.slice(0, 80), a.origin, a.openapiUrl, a.taskId],
  );
  return id;
}
