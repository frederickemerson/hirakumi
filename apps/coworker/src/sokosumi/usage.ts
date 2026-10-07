import type pg from "pg";
import type { SokosumiClient } from "./client.js";

type Row = { task_id: string; sokosumi_user_id: string; sokosumi_organization_id: string | null; api_id: string };

/** Bills the onboarding fee once per Sokosumi task, after its API is Live (spec §9). */
export async function reportOnboardingUsage(pool: pg.Pool, soko: SokosumiClient, credits: number): Promise<number> {
  const { rows } = await pool.query<Row>(
    `select ct.task_id, ct.sokosumi_user_id, ct.sokosumi_organization_id, min(a.id) as api_id
     from coworker_tasks ct join apis a on a.sokosumi_task_id = ct.task_id
     where a.state = 'live' and ct.usage_reported_at is null
     group by ct.task_id, ct.sokosumi_user_id, ct.sokosumi_organization_id`,
  );
  let reported = 0;
  for (const r of rows) {
    // One row Sokosumi keeps refusing must not stop every later fee; it is retried on the next pass.
    try {
      await soko.reportUsage({
        userId: r.sokosumi_user_id,
        organizationId: r.sokosumi_organization_id,
        idempotencyKey: `usage:${r.task_id}:onboarding`,
        credits,
        referenceId: r.api_id,
      });
    } catch (e) {
      console.error(`[usage] task ${r.task_id}:`, (e as Error).message);
      continue;
    }
    await pool.query(`update coworker_tasks set usage_reported_at = now() where task_id = $1`, [r.task_id]);
    reported++;
  }
  return reported;
}
