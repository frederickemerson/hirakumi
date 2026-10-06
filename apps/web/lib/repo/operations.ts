import type { Sql } from "../db";
import { validateEndpointSelection, type EndpointSelection } from "../endpoints";
import type { ApiState, Operation, RepoResult } from "../types";

export const OPERATION_COLUMNS = [
  "id", "op_id", "method", "path", "description", "side_effects_likely", "side_effects_confirmed_none", "enabled",
];

export async function listOperations(sql: Sql, apiId: string): Promise<Operation[]> {
  return sql<Operation[]>`select ${sql(OPERATION_COLUMNS)} from operations where api_id = ${apiId} order by path, method`;
}

export async function confirmEndpoints(
  sql: Sql,
  a: { apiId: string; sellerId: string; selection: EndpointSelection },
): Promise<RepoResult> {
  return sql.begin(async (tx): Promise<RepoResult> => {
    const [api] = await tx<{ state: ApiState }[]>`
      select state from apis where id = ${a.apiId} and seller_id = ${a.sellerId} for update`;
    if (!api) return { ok: false, status: 404, error: "We couldn't find that API in your account." };
    if (api.state !== "described" && api.state !== "endpoints_confirmed") {
      return { ok: false, status: 409, error: "Endpoints can't be changed at this stage. Reload the page." };
    }
    const ops = await tx<Operation[]>`select ${tx(OPERATION_COLUMNS)} from operations where api_id = ${a.apiId}`;
    const problem = validateEndpointSelection(ops, a.selection);
    if (problem) return { ok: false, status: 400, error: problem };
    const enabled = new Set(a.selection.enabledIds);
    const confirmed = new Set(a.selection.confirmedNoSideEffectIds);
    for (const op of ops) {
      await tx`
        update operations
        set enabled = ${enabled.has(op.id)}, side_effects_confirmed_none = ${enabled.has(op.id) && confirmed.has(op.id)}
        where id = ${op.id}`;
    }
    const escrowOp = ops.find((o) => o.id === a.selection.escrowOperationId);
    await tx`update apis set escrow_op_id = ${escrowOp!.opId}, state = 'endpoints_confirmed' where id = ${a.apiId}`;
    return { ok: true };
  });
}
