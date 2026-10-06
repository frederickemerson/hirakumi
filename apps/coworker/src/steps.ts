import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTx, type Db } from "./db.js";
import { PermanentError } from "./errors.js";
import { enqueueMessage } from "./messages.js";
import type { HumanStep } from "./humanSteps.js";

export const MAX_ATTEMPTS = 3;
export type StepName = "parse" | "describe" | "qa" | "register";
export type StepStatus = "pending" | "running" | "done" | "failed" | "waiting_seller";
export type StepRow = {
  status: StepStatus;
  attempts: number;
  output: Record<string, unknown> | null;
  updated_at: Date;
};

/** The web stepper name for each driven step (used on Sokosumi task comments). */
export const HUMAN_STEP_OF: Record<StepName, HumanStep> = {
  parse: "Read your file",
  describe: "Describe endpoints",
  qa: "Test calls",
  register: "Register on Masumi",
};

export const STEP_LABELS: Record<StepName, string> = {
  parse: "reading your OpenAPI file",
  describe: "describing your endpoints",
  qa: "test calls",
  register: "registering on Masumi",
};

export function backoffMs(attempts: number): number {
  return attempts <= 0 ? 0 : 5_000 * 2 ** (attempts - 1);
}

/** Whether the driver should (re)run a step now. 'running' means a previous process died mid-step. */
export function isDue(row: StepRow | null, now: Date): boolean {
  if (!row) return true;
  if (row.status === "running") return true;
  if (row.status === "pending") return now.getTime() - row.updated_at.getTime() >= backoffMs(row.attempts);
  return false;
}

export async function getStep(db: Db, apiId: string, step: StepName): Promise<StepRow | null> {
  const { rows } = await db.query<StepRow>(
    `select status, attempts, output, updated_at from onboard_steps where api_id = $1 and step = $2`,
    [apiId, step],
  );
  return rows[0] ?? null;
}

export async function startStep(db: Db, apiId: string, step: StepName): Promise<StepRow> {
  const { rows } = await db.query<StepRow>(
    `insert into onboard_steps (api_id, step, status, attempts, updated_at) values ($1, $2, 'running', 1, now())
     on conflict (api_id, step) do update set status = 'running', attempts = onboard_steps.attempts + 1, updated_at = now()
     returning status, attempts, output, updated_at`,
    [apiId, step],
  );
  return rows[0];
}

export async function finishStep(db: Db, apiId: string, step: StepName, output: Record<string, unknown>): Promise<void> {
  await db.query(
    `insert into onboard_steps (api_id, step, status, attempts, output, updated_at) values ($1, $2, 'done', 0, $3::jsonb, now())
     on conflict (api_id, step) do update
       set status = 'done', output = (coalesce(onboard_steps.output, '{}'::jsonb) - 'error') || $3::jsonb, updated_at = now()`,
    [apiId, step, JSON.stringify(output)],
  );
}

export async function saveStepOutput(
  db: Db,
  apiId: string,
  step: StepName,
  patch: Record<string, unknown>,
  status?: StepStatus,
): Promise<void> {
  await db.query(
    `update onboard_steps set output = coalesce(output, '{}'::jsonb) || $3::jsonb, status = coalesce($4::text, status), updated_at = now()
     where api_id = $1 and step = $2`,
    [apiId, step, JSON.stringify(patch), status ?? null],
  );
}

export async function touchStep(db: Db, apiId: string, step: StepName): Promise<void> {
  await db.query(`update onboard_steps set updated_at = now() where api_id = $1 and step = $2`, [apiId, step]);
}

export async function failStep(
  db: Db,
  apiId: string,
  step: StepName,
  reason: string,
  permanent: boolean,
): Promise<"retry" | "failed"> {
  const { rows } = await db.query<{ status: StepStatus }>(
    `update onboard_steps
       set status = case when $4::boolean or attempts >= $5::int then 'failed' else 'pending' end,
           output = coalesce(output, '{}'::jsonb) || jsonb_build_object('error', $3::text),
           updated_at = now()
     where api_id = $1 and step = $2
     returning status`,
    [apiId, step, reason, permanent, MAX_ATTEMPTS],
  );
  return rows[0]?.status === "failed" ? "failed" : "retry";
}

export type StepOutcome = "skipped" | "ran" | "retry" | "failed";

/**
 * Runs one attempt of an onboarding step. The body must make its own writes idempotent and commit
 * its state transition with a compare-and-set. Failures are counted; a PermanentError or the
 * MAX_ATTEMPTS-th failure marks the step failed and tells the seller, in the same transaction.
 */
export async function runStep(
  pool: pg.Pool,
  apiId: string,
  step: StepName,
  body: (previous: StepRow | null) => Promise<void>,
  now: Date = new Date(),
): Promise<StepOutcome> {
  const previous = await getStep(pool, apiId, step);
  if (!isDue(previous, now)) return "skipped";
  await startStep(pool, apiId, step);
  try {
    await body(previous);
    return "ran";
  } catch (e) {
    const permanent = e instanceof PermanentError;
    const reason = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    return withTx(pool, async (c) => {
      const outcome = await failStep(c, apiId, step, reason, permanent);
      if (outcome === "failed") {
        const text = permanent ? reason : `it kept failing after ${MAX_ATTEMPTS} tries. Last error: ${reason}`;
        await enqueueMessage(c, {
          apiId,
          body: `I had to stop at "${STEP_LABELS[step]}": ${text}`,
          taskStatus: "INPUT_REQUIRED",
          dedupeKey: `failed:${apiId}:${step}:${randomUUID()}`,
          step: HUMAN_STEP_OF[step],
        });
      }
      return outcome;
    });
  }
}
