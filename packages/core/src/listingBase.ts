import { specDirectory } from "./ownership";

/**
 * One API, one listing, one account. An API's identity is its upstream base: origin + path_prefix (set by the
 * parse step from servers[0]). From the moment ownership is proven, no two active APIs may share a base, and
 * bases that overlap (one is a folder of the other) may only belong to the same account.
 *
 * The normalization here must match the generated columns apis.base_origin and apis.base_path
 * (db/migrations/0010_one_api_one_listing.sql). The db test checks they agree.
 */

/** States from proven ownership on. 'retired' frees the base, and so does deleting the row. */
export const ACTIVE_LISTING_STATES = ["ownership_verified", "rule_built", "priced", "registering", "live"] as const;

export const LISTED_BY_OTHER = "This API is already listed by another account. If it's yours, retire that listing first.";

export const overlapWarning = (name: string) => `This overlaps your listing ${name}, so some calls may be sold in both.`;

export const duplicateOwn = (name: string) => `You already list this API as ${name}. Retire that listing first.`;

/** Lowercased, without a default port or trailing slash. Same string steps as the SQL column. */
export function normalizeOrigin(origin: string): string {
  return origin
    .replace(/\/+$/, "")
    .toLowerCase()
    .replace(/^(https:\/\/[^/]+):443$/, "$1")
    .replace(/^(http:\/\/[^/]+):80$/, "$1");
}

/** The base path as a directory with a trailing slash, as checkSpecBinding treats it. */
export function normalizeBasePath(path: string): string {
  if (path === "") return "/";
  return path.endsWith("/") ? path : `${path}/`;
}

export type Base = { origin: string; pathPrefix: string };
export type BaseRelation = "exact" | "overlap" | null;

/** "exact" for the same base, "overlap" when one is a folder of the other (whole segments only), else null. */
export function compareBases(a: Base, b: Base): BaseRelation {
  if (normalizeOrigin(a.origin) !== normalizeOrigin(b.origin)) return null;
  const pa = normalizeBasePath(a.pathPrefix);
  const pb = normalizeBasePath(b.pathPrefix);
  if (pa === pb) return "exact";
  return pa.startsWith(pb) || pb.startsWith(pa) ? "overlap" : null;
}

/** An active API on the same origin, as read from the database. */
export type ListedBase = { id: string; sellerId: string; name: string; origin: string; pathPrefix: string };

export type BaseVerdict =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: "taken_by_other" | "duplicate_own"; message: string };

/** The rule. Another account's listing is never named; the seller's own listing is. */
export function judgeListingBase(me: Base & { sellerId: string }, others: ListedBase[]): BaseVerdict {
  const warnings: string[] = [];
  let own: string | null = null;
  for (const o of others) {
    const rel = compareBases(me, o);
    if (!rel) continue;
    if (o.sellerId !== me.sellerId) return { ok: false, reason: "taken_by_other", message: LISTED_BY_OTHER };
    if (rel === "exact") own ??= o.name;
    else warnings.push(overlapWarning(o.name));
  }
  return own !== null ? { ok: false, reason: "duplicate_own", message: duplicateOwn(own) } : { ok: true, warnings };
}

/**
 * Advisory check on a submitted link, before the base is known. The base will lie at or under the OpenAPI
 * file's folder (checkSpecBinding), so another account's base at or above that folder is a sure conflict.
 */
export function takenEarly(me: { sellerId: string; openapiUrl: string }, others: ListedBase[]): boolean {
  const spec = new URL(me.openapiUrl);
  const dir = specDirectory(spec);
  return others.some((o) =>
    o.sellerId !== me.sellerId
    && normalizeOrigin(o.origin) === normalizeOrigin(spec.origin)
    && dir.startsWith(normalizeBasePath(o.pathPrefix)));
}

/** Runs SQL with $n parameters and returns the rows. Fits pg (`c.query(...).rows`) and postgres.js (`tx.unsafe`). */
export type QueryFn = (text: string, params: unknown[]) => Promise<readonly Record<string, unknown>[]>;

const ACTIVE_SQL = ACTIVE_LISTING_STATES.map((s) => `'${s}'`).join(", ");

/** Active APIs on one normalized origin, other than `exceptId`. Column names are single words for both drivers. */
export async function listActiveOnOrigin(query: QueryFn, origin: string, exceptId = ""): Promise<ListedBase[]> {
  const rows = await query(
    `select id, seller_id as owner, name, origin, path_prefix as prefix from apis
     where base_origin = $1 and id <> $2 and state in (${ACTIVE_SQL})`,
    [normalizeOrigin(origin), exceptId],
  );
  return rows.map((r) => ({
    id: String(r.id), sellerId: String(r.owner), name: String(r.name), origin: String(r.origin), pathPrefix: String(r.prefix),
  }));
}

/**
 * The authoritative check, run inside the transaction that proves ownership. The advisory lock on the
 * normalized origin serialises every proof on that origin, so two of them can't both see a free base.
 */
export async function checkListingBase(
  query: QueryFn,
  me: Base & { apiId: string; sellerId: string },
): Promise<BaseVerdict> {
  await query("select pg_advisory_xact_lock(hashtext('api-base|' || $1))", [normalizeOrigin(me.origin)]);
  return judgeListingBase(me, await listActiveOnOrigin(query, me.origin, me.apiId));
}

/** Name of the unique index that backs up the exact-duplicate rule. */
export const ACTIVE_BASE_INDEX = "apis_active_base_uniq";
