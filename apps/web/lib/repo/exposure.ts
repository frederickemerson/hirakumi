import type { Exposure, RuleDefinition } from "@hirakumi/core";
import type { Sql } from "../db";
import { hasExposureSchema } from "./schema";

/** One sellable endpoint as the leak check calls it: its saved test input and its latest promise. */
export type ExposureTarget = {
  opId: string;
  method: string;
  path: string;
  /** The first input the test calls saved for it (test_inputs), or null when none was saved. */
  input: Record<string, unknown> | null;
  /** The latest promise, or null when it has none yet. */
  rule: RuleDefinition | null;
};

/** The API's address and every enabled endpoint, or null when the API is gone. */
export async function loadExposureTargets(
  sql: Sql,
  apiId: string,
): Promise<{ origin: string; pathPrefix: string; targets: ExposureTarget[] } | null> {
  const [api] = await sql<{ origin: string; pathPrefix: string }[]>`
    select origin, path_prefix from apis where id = ${apiId} and deleted_at is null`;
  if (!api) return null;
  const targets = await sql<ExposureTarget[]>`
    select o.op_id, o.method, o.path,
      (select t.input from test_inputs t where t.operation_id = o.id order by t.id limit 1) as input,
      (select r.definition from rules r where r.operation_id = o.id order by r.version desc limit 1) as rule
    from operations o
    where o.api_id = ${apiId} and o.enabled
    order by o.path, o.method`;
  return { origin: api.origin, pathPrefix: api.pathPrefix, targets };
}

export type StoredExposure = { exposure: Exposure; checkedAt: Date | null };

/** The last result, or null before migration 0019. */
export async function getStoredExposure(sql: Sql, apiId: string): Promise<StoredExposure | null> {
  if (!(await hasExposureSchema(sql))) return null;
  const [row] = await sql<{ exposure: Exposure; exposureCheckedAt: Date | null }[]>`
    select exposure, exposure_checked_at from apis where id = ${apiId}`;
  return row ? { exposure: row.exposure, checkedAt: row.exposureCheckedAt } : null;
}

/** Stores a result. Nothing is stored before migration 0019. */
export async function storeExposure(sql: Sql, apiId: string, exposure: Exposure): Promise<void> {
  if (!(await hasExposureSchema(sql))) return;
  await sql`update apis set exposure = ${exposure}, exposure_checked_at = now() where id = ${apiId}`;
}
