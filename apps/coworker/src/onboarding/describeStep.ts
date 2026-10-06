import type pg from "pg";
import { withTx } from "../db.js";
import { PermanentError } from "../errors.js";
import { apiLink } from "../links.js";
import type { StructuredCall } from "../llm/claude.js";
import { describeOperations } from "../llm/describe.js";
import { enqueueMessage } from "../messages.js";
import type { OpForLlm } from "../openapi/parse.js";
import { chooseEndpointsPrompt } from "../sokosumi/conversation.js";
import { listOps } from "../sokosumi/sellerActions.js";
import { finishStep, getStep, runStep, type StepOutcome } from "../steps.js";

export type DescribeDeps = { pool: pg.Pool; llm: StructuredCall; webBaseUrl: string; now?: () => Date };

/** parsed → described: ONE Claude call for every operation's description and side-effects flag. */
export async function describeStep(deps: DescribeDeps, apiId: string): Promise<StepOutcome> {
  return runStep(deps.pool, apiId, "describe", async () => {
    const parse = await getStep(deps.pool, apiId, "parse");
    const ops = parse?.output?.ops as OpForLlm[] | undefined;
    if (!ops?.length) throw new PermanentError("internal: the parse step left no operations to describe.");
    const { byOpId, usedFallback } = await describeOperations(deps.llm, ops);
    const sellable = [...byOpId.values()].filter((d) => !d.sideEffectsLikely).length;
    await withTx(deps.pool, async (c) => {
      const moved = await c.query(`update apis set state = 'described' where id = $1 and state = 'parsed'`, [apiId]);
      if (moved.rowCount !== 1) return;
      for (const [opId, d] of byOpId) {
        await c.query(`update operations set description = $3, side_effects_likely = $4 where api_id = $1 and op_id = $2`, [apiId, opId, d.description, d.sideEffectsLikely]);
      }
      await finishStep(c, apiId, "describe", { sellable, usedFallback });
      // A Sokosumi task can choose by reply (`sell 1 2`), so it gets the numbered list; the dashboard has the web picker.
      const { rows: [api] } = await c.query<{ sokosumi_task_id: string | null }>(`select sokosumi_task_id from apis where id = $1`, [apiId]);
      await enqueueMessage(c, {
        apiId,
        body: api?.sokosumi_task_id
          ? chooseEndpointsPrompt(await listOps(c, apiId), sellable, deps.webBaseUrl, apiId)
          : `Found ${ops.length} endpoints; ${sellable} look sellable (read-only). Pick the ones to sell and confirm they have no side effects: ${apiLink(deps.webBaseUrl, apiId)}`,
        taskStatus: "INPUT_REQUIRED",
        dedupeKey: `described:${apiId}`,
        step: "Describe endpoints",
      });
    });
  }, deps.now?.());
}
