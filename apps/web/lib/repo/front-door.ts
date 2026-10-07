import type postgres from "postgres";
import type { Sql } from "../db";
import type { DomainStatus } from "../gateway";
import { hasFrontDoorSchema } from "./schema";

type Tx = postgres.TransactionSql;

/** This API's front-door host and its status, or null (none, or migration 0020 has not run). */
export async function getFrontDoorSummary(sql: Sql, apiId: string): Promise<{ host: string; status: DomainStatus } | null> {
  if (!(await hasFrontDoorSchema(sql))) return null;
  const [row] = await sql<{ host: string; status: DomainStatus }[]>`
    select d.host, d.status from apis a join api_domains d on d.host = a.public_host where a.id = ${apiId}`;
  return row ?? null;
}

/**
 * Takes the API off the front door (retire, delete): public_host cleared, and its host detached once no other live
 * API of the seller uses it, so Caddy gets no certificate and the gateway answers 421. The same rule as
 * @hirakumi/db detachApiFrontDoor. Returns the host, or null when the API had none.
 */
export async function detachFrontDoor(sql: Sql | Tx, apiId: string): Promise<string | null> {
  if (!(await hasFrontDoorSchema(sql))) return null;
  const [api] = await sql<{ publicHost: string | null }[]>`select public_host from apis where id = ${apiId} and public_host is not null`;
  const host = api?.publicHost ?? null;
  if (!host) return null;
  await sql`update apis set public_host = null where id = ${apiId}`;
  await sql`
    update api_domains set status = 'detached', last_error = null
    where host = ${host} and status <> 'detached'
      and not exists (select 1 from apis where public_host = ${host} and state <> 'retired' and deleted_at is null)`;
  return host;
}

/** The API's proven ownership code (its latest consumed dns or header code): the TXT value a new origin reuses. */
export async function getProvenCode(sql: Sql, apiId: string): Promise<string | null> {
  const [row] = await sql<{ token: string }[]>`
    select token from challenges
    where api_id = ${apiId} and kind in ('dns', 'header') and consumed_at is not null and proof ? 'passedAt'
    order by consumed_at desc, id desc limit 1`;
  return row?.token ?? null;
}

/** A dashboard-only chat message (no Sokosumi task) so the steps stay after the dialog closes. */
export async function postUndoMessage(sql: Sql | Tx, a: { apiId: string | null; sellerId: string; body: string }): Promise<void> {
  await sql`insert into messages (api_id, seller_id, author, body) values (${a.apiId}, ${a.sellerId}, 'coworker', ${a.body})`;
}
