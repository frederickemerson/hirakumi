import type { Sql } from "./db";

export type TryOperationRow = {
  opId: string;
  method: string;
  path: string;
  description: string | null;
  inputSchema: { properties?: Record<string, Record<string, unknown>>; required?: string[] };
};

/** Enabled endpoints of a live API with their input schemas, for the public try page. */
export async function listTryOperations(sql: Sql, apiId: string): Promise<TryOperationRow[]> {
  return sql<TryOperationRow[]>`
    select o.op_id, o.method, o.path, o.description, o.input_schema
    from operations o join apis a on a.id = o.api_id
    where o.api_id = ${apiId} and o.enabled and a.state = 'live'
    order by o.path, o.method`;
}
