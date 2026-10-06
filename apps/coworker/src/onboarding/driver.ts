import type pg from "pg";

export type DrivenState = "intake" | "parsed" | "ownership_verified" | "registering";
export type StateHandlers = Record<DrivenState, (apiId: string) => Promise<unknown>>;
export type Logger = Pick<Console, "error" | "info">;

/**
 * One pass over every API that is waiting on the coworker. Each API is handled at most once at a
 * time (inFlight), different APIs run concurrently. Single coworker process (docker compose: 1 replica).
 */
export async function driveOnce(pool: pg.Pool, handlers: StateHandlers, inFlight: Set<string>, log: Logger = console): Promise<void> {
  const { rows } = await pool.query<{ id: string; state: DrivenState }>(
    // A failed step is never re-run, so such an API has nothing left for the driver; skipping it keeps
    // failed onboardings from filling the oldest-first window and stalling new ones.
    `select id, state from apis
     where state in ('intake', 'parsed', 'ownership_verified', 'registering')
       and not exists (select 1 from onboard_steps s where s.api_id = apis.id and s.status = 'failed')
     order by created_at limit 50`,
  );
  await Promise.all(
    rows
      .filter((r) => !inFlight.has(r.id))
      .map(async (r) => {
        inFlight.add(r.id);
        try {
          await handlers[r.state](r.id);
        } catch (e) {
          log.error(`[driver] ${r.id} (${r.state}) failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          inFlight.delete(r.id);
        }
      }),
  );
}
