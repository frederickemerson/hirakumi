import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { StoredUpstreamAuth } from "@hirakumi/core";
import type { Sql } from "./client";

type Tx = postgres.TransactionSql;

/**
 * The Hirakumi front door (migration 0020): a seller's public hostname answered by the gateway. pending_dns and
 * active are served and get a certificate; detached and disabled answer 421 and get none.
 */
export type DomainStatus = "pending_dns" | "active" | "detached" | "disabled";
export const SERVED_DOMAIN_STATUSES: readonly DomainStatus[] = ["pending_dns", "active"];

export type DomainRoute = {
  host: string; status: DomainStatus; sellerId: string; txtVerifiedAt: Date | null;
  /** The APIs answered on this host, longest path prefix first, so the most specific folder wins. */
  apis: { id: string; pathPrefix: string }[];
};

/** What the front door needs for one Host: the domain and the APIs on it. Null when the host is unknown. */
export async function getDomainRoute(sql: Sql, host: string): Promise<DomainRoute | null> {
  const [d] = await sql<{ host: string; status: DomainStatus; seller_id: string; txt_verified_at: Date | null }[]>`
    select host, status, seller_id, txt_verified_at from api_domains where host = ${host}`;
  if (!d) return null;
  const apis = await sql<{ id: string; path_prefix: string }[]>`
    select id, path_prefix from apis
    where public_host = ${host} and seller_id = ${d.seller_id} and state <> 'retired' and deleted_at is null
    order by length(rtrim(path_prefix, '/')) desc, id`;
  return {
    host: d.host, status: d.status, sellerId: d.seller_id, txtVerifiedAt: d.txt_verified_at,
    apis: apis.map((a) => ({ id: a.id, pathPrefix: a.path_prefix })),
  };
}

/** Caddy's on-demand TLS ask: a certificate only for a served host whose _hirakumi TXT was verified. */
export function tlsAllowed(route: Pick<DomainRoute, "status" | "txtVerifiedAt"> | null): boolean {
  return !!route && SERVED_DOMAIN_STATUSES.includes(route.status) && route.txtVerifiedAt !== null;
}

/** The host of an origin URL, lowercase, without a trailing dot. */
export function originHost(origin: string): string {
  return new URL(origin).hostname.toLowerCase().replace(/\.$/, "");
}

export type FrontDoorLimits = { maxPerSeller: number; maxNewPerHour: number };
export const DEFAULT_FRONT_DOOR_LIMITS: FrontDoorLimits = { maxPerSeller: 3, maxNewPerHour: 20 };

export type AttachResult =
  | { ok: true; host: string }
  | { ok: false; reason: "api_not_found" | "retired" | "origin_changed" | "host_in_use" | "seller_limit" | "busy" | "base_taken"; detail: string };

/**
 * Moves an API behind the front door, in one transaction: the gateway now calls `newOrigin` with the key sealed for
 * it, and `publicHost` (the API's old address, whose _hirakumi TXT the caller just checked) becomes a pending_dns
 * domain of this seller. The caller checked the new origin's TXT record and that test calls there pass.
 * Refused when the API's address moved since the caller read it, when another listing uses the host as its own
 * address or another seller holds it, or past the limits (a certificate per host, so they are capped).
 */
export async function attachFrontDoor(
  sql: Sql,
  a: { apiId: string; expectedOrigin: string; newOrigin: string; publicHost: string; upstreamAuth: StoredUpstreamAuth; limits?: FrontDoorLimits },
): Promise<AttachResult> {
  const limits = a.limits ?? DEFAULT_FRONT_DOOR_LIMITS;
  try {
    return await sql.begin(async (tx): Promise<AttachResult> => {
      const [api] = await tx<{ seller_id: string; origin: string; state: string; deleted_at: Date | null }[]>`
        select seller_id, origin, state, deleted_at from apis where id = ${a.apiId} for update`;
      if (!api || api.deleted_at) return { ok: false, reason: "api_not_found", detail: "This API was not found." };
      if (api.state === "retired") return { ok: false, reason: "retired", detail: "This API was removed from Hirakumi." };
      if (api.origin !== a.expectedOrigin) {
        return { ok: false, reason: "origin_changed", detail: "This API's address changed while you were setting this up. Reload the page." };
      }
      // Serialise every front-door change: the limits below count rows other requests may be adding.
      await tx`select pg_advisory_xact_lock(727275)`;
      const others = await tx<{ id: string }[]>`
        select id from apis
        where id <> ${a.apiId} and state <> 'retired' and deleted_at is null
          and (lower(rtrim(split_part(split_part(origin, '://', 2), '/', 1), '.')) in (${a.publicHost}, ${`${a.publicHost}:443`}, ${`${a.publicHost}:80`})
               or (public_host = ${a.publicHost} and seller_id <> ${api.seller_id}))
        limit 1`;
      if (others.length) {
        return { ok: false, reason: "host_in_use", detail: `Another listing uses ${a.publicHost} as its address, so it can't also be a front door.` };
      }
      const [existing] = await tx<{ seller_id: string; status: DomainStatus }[]>`
        select seller_id, status from api_domains where host = ${a.publicHost} for update`;
      if (existing && existing.seller_id !== api.seller_id && SERVED_DOMAIN_STATUSES.includes(existing.status)) {
        return { ok: false, reason: "host_in_use", detail: `${a.publicHost} is already a front door on another account.` };
      }
      const [{ mine }] = await tx<{ mine: number }[]>`
        select count(*)::int as mine from api_domains
        where seller_id = ${api.seller_id} and host <> ${a.publicHost} and status in ('pending_dns', 'active')`;
      if (mine >= limits.maxPerSeller) {
        return { ok: false, reason: "seller_limit", detail: `An account can use the front door on ${limits.maxPerSeller} hostnames. Stop it on one first.` };
      }
      if (!existing || !SERVED_DOMAIN_STATUSES.includes(existing.status)) {
        const [{ recent }] = await tx<{ recent: number }[]>`
          select count(*)::int as recent from api_domains where created_at > now() - interval '1 hour'`;
        if (recent >= limits.maxNewPerHour) {
          return { ok: false, reason: "busy", detail: "Many front doors were set up in the last hour. Try again in an hour." };
        }
      }
      // A host this seller (or, once released, anyone who proves it) used before starts over as pending_dns.
      await tx`
        insert into api_domains (host, seller_id, status, txt_verified_at)
        values (${a.publicHost}, ${api.seller_id}, 'pending_dns', now())
        on conflict (host) do update set
          seller_id = excluded.seller_id,
          status = case when api_domains.status = 'active' and api_domains.seller_id = excluded.seller_id then 'active' else 'pending_dns' end,
          txt_verified_at = now(), failures = 0, last_error = null,
          routed_at = case when api_domains.seller_id = excluded.seller_id then api_domains.routed_at else null end,
          created_at = case when api_domains.status in ('pending_dns', 'active') then api_domains.created_at else now() end`;
      await tx`
        update apis set origin = ${a.newOrigin}, upstream_auth = ${tx.json(a.upstreamAuth as unknown as postgres.JSONValue)}, public_host = ${a.publicHost}
        where id = ${a.apiId}`;
      return { ok: true, host: a.publicHost };
    });
  } catch (e) {
    // apis_active_base_uniq: another active listing already has this origin and path prefix.
    if ((e as { code?: string; constraint_name?: string }).code === "23505") {
      return { ok: false, reason: "base_taken", detail: "Another listing already uses that origin and folder." };
    }
    throw e;
  }
}

/** The routed check passed: Hirakumi answers this host. */
export async function activateDomain(sql: Sql, host: string, nextCheckAt: Date): Promise<void> {
  await sql`
    update api_domains set status = 'active', routed_at = now(), failures = 0, last_error = null, next_check_at = ${nextCheckAt}
    where host = ${host} and status in ('pending_dns', 'active')`;
}

/** A failed check the seller asked for: noted for the page, never counted. */
export async function noteDomainError(sql: Sql, host: string, detail: string): Promise<void> {
  await sql`update api_domains set last_error = ${detail} where host = ${host}`;
}

/**
 * Takes an API off the front door: its public_host is cleared, and the domain is detached once no other API of the
 * seller uses it (no certificate, the front door answers 421). Returns the host, or null when it had none. Used by
 * "Stop using the front door", retire and delete, inside their transactions.
 */
export async function detachApiFrontDoor(sql: Sql | Tx, apiId: string): Promise<{ host: string; detached: boolean } | null> {
  const [api] = await sql<{ public_host: string | null }[]>`
    select public_host from apis where id = ${apiId} and public_host is not null`;
  if (!api?.public_host) return null;
  const host = api.public_host;
  await sql`update apis set public_host = null where id = ${apiId}`;
  const rows = await sql`
    update api_domains set status = 'detached', last_error = null
    where host = ${host} and status <> 'detached'
      and not exists (select 1 from apis where public_host = ${host} and state <> 'retired' and deleted_at is null)
    returning host`;
  return { host, detached: rows.length > 0 };
}

// ---------------------------------------------------------------- monitor

/** A served (or disabled) domain and the codes that may prove it: each API on it's latest proven ownership code. */
export type DomainRecheckTarget = {
  host: string; status: DomainStatus; sellerId: string; failures: number; nextCheckAt: Date | null; lastError: string | null; codes: string[];
};

export async function listDomainRecheckTargets(sql: Sql): Promise<DomainRecheckTarget[]> {
  const rows = await sql<{ host: string; status: DomainStatus; seller_id: string; failures: number; next_check_at: Date | null; last_error: string | null; codes: string[] | null }[]>`
    select d.host, d.status, d.seller_id, d.failures, d.next_check_at, d.last_error,
           (select array_agg(c.token order by c.token) from apis a
              join lateral (
                select token from challenges c
                where c.api_id = a.id and c.kind in ('dns', 'header') and c.consumed_at is not null and c.proof ? 'passedAt'
                order by c.consumed_at desc, c.id desc limit 1
              ) c on true
            where a.public_host = d.host and a.seller_id = d.seller_id and a.state <> 'retired' and a.deleted_at is null) as codes
    from api_domains d
    where d.status in ('pending_dns', 'active', 'disabled')
    order by d.host`;
  return rows.map((r) => ({
    host: r.host, status: r.status, sellerId: r.seller_id, failures: r.failures, nextCheckAt: r.next_check_at,
    lastError: r.last_error, codes: r.codes ?? [],
  }));
}

export async function scheduleDomainRecheck(sql: Sql, host: string, at: Date): Promise<void> {
  await sql`update api_domains set next_check_at = ${at} where host = ${host} and next_check_at is null`;
}

/**
 * pass: TXT and routing both hold. txt_missing: the code is gone (two in a row disable the host). not_routed: the
 * host resolves elsewhere (two in a row detach it, an active host only). error: DNS did not answer, nothing counts.
 */
export type DomainRecheckOutcome = "pass" | "txt_missing" | "not_routed" | "error";
export const DOMAIN_FAILS_TO_ACT = 2;

export type DomainRecheckResult = { status: DomainStatus; failures: number; changed: boolean };

/**
 * Records one re-check of a domain in one transaction. A change of status is told to the seller of each API on it
 * (messages), and a detach clears the APIs' public_host. Sales on Hirakumi's own URLs never stop for this.
 */
export async function recordDomainRecheck(
  sql: Sql,
  a: { host: string; outcome: DomainRecheckOutcome; detail: string; nextAt: Date; messages: Partial<Record<DomainStatus, string>> },
): Promise<DomainRecheckResult> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ status: DomainStatus; failures: number; last_error: string | null }[]>`
      select status, failures, last_error from api_domains where host = ${a.host} for update`;
    if (!row || row.status === "detached") return { status: row?.status ?? "detached", failures: row?.failures ?? 0, changed: false };
    let status: DomainStatus = row.status;
    let failures = row.failures;
    let lastError = row.last_error;
    if (a.outcome === "pass") {
      failures = 0;
      lastError = null;
      if (status === "disabled") status = "active";
    } else if (a.outcome !== "error") {
      // Counts in a row of the same kind: a TXT miss after a routing miss starts again at one.
      failures = lastError?.startsWith(`${a.outcome}:`) ? failures + 1 : 1;
      lastError = `${a.outcome}: ${a.detail}`;
      if (failures >= DOMAIN_FAILS_TO_ACT) {
        if (a.outcome === "txt_missing" && status !== "disabled") status = "disabled";
        if (a.outcome === "not_routed" && status === "active") status = "detached";
      }
    }
    const changed = status !== row.status;
    await tx`
      update api_domains set status = ${status}, failures = ${failures}, last_error = ${lastError}, next_check_at = ${a.nextAt},
        routed_at = case when ${status} = 'detached' then null else routed_at end
      where host = ${a.host}`;
    const message = changed ? a.messages[status] : undefined;
    if (message) {
      await tx`
        insert into messages (api_id, seller_id, task_id, author, body, dedupe_key)
        select id, seller_id, sokosumi_task_id, 'coworker', ${message}, 'front_door_' || ${status} || ':' || id || ':' || ${`${Date.now()}:${randomUUID()}`}
        from apis where public_host = ${a.host} and state <> 'retired' and deleted_at is null
        on conflict (dedupe_key) do nothing`;
    }
    if (status === "detached") await tx`update apis set public_host = null where public_host = ${a.host}`;
    return { status, failures, changed };
  });
}

/** The proven ownership code of an API (its latest consumed dns or header code), or null. */
export async function getProvenVerifyCode(sql: Sql, apiId: string): Promise<string | null> {
  const [row] = await sql<{ token: string }[]>`
    select token from challenges
    where api_id = ${apiId} and kind in ('dns', 'header') and consumed_at is not null and proof ? 'passedAt'
    order by consumed_at desc, id desc limit 1`;
  return row?.token ?? null;
}

export type FrontDoorState = {
  origin: string; pathPrefix: string; state: string; sellerId: string; publicHost: string | null;
  domain: { host: string; status: DomainStatus; txtVerifiedAt: Date | null; routedAt: Date | null; lastError: string | null } | null;
};

/** One API's front-door state: its origin and the domain it is answered on, if any. */
export async function getFrontDoorState(sql: Sql, apiId: string): Promise<FrontDoorState | null> {
  const [row] = await sql<{
    origin: string; path_prefix: string; state: string; seller_id: string; public_host: string | null;
    status: DomainStatus | null; txt_verified_at: Date | null; routed_at: Date | null; last_error: string | null;
  }[]>`
    select a.origin, a.path_prefix, a.state, a.seller_id, a.public_host, d.status, d.txt_verified_at, d.routed_at, d.last_error
    from apis a left join api_domains d on d.host = a.public_host
    where a.id = ${apiId} and a.deleted_at is null`;
  if (!row) return null;
  return {
    origin: row.origin, pathPrefix: row.path_prefix, state: row.state, sellerId: row.seller_id, publicHost: row.public_host,
    domain: row.public_host && row.status
      ? { host: row.public_host, status: row.status, txtVerifiedAt: row.txt_verified_at, routedAt: row.routed_at, lastError: row.last_error }
      : null,
  };
}
