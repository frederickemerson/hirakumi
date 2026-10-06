-- One API, one listing, one account.
-- An API's identity is its upstream base: origin + path_prefix (path_prefix is set by the parse step from
-- servers[0]). From proven ownership on, no two active APIs may share a base. The web app checks this (and
-- overlapping bases) under an advisory lock when ownership is proven; this index is the backstop for exact
-- duplicates. Normalization must match @hirakumi/core listingBase.ts (normalizeOrigin, normalizeBasePath).

-- Lowercased origin without a trailing slash or default port; path as a directory with one trailing slash.
alter table apis
  add column base_origin text generated always as (
    regexp_replace(regexp_replace(lower(rtrim(origin, '/')), '^(https://[^/]+):443$', '\1'), '^(http://[^/]+):80$', '\1')
  ) stored,
  add column base_path text generated always as (
    case when path_prefix = '' then '/' when right(path_prefix, 1) = '/' then path_prefix else path_prefix || '/' end
  ) stored,
  -- True only for rows that already duplicated an active base before this migration (see below).
  add column base_legacy_duplicate boolean not null default false;

-- Existing data. Before this migration nothing stopped two sellers from proving the same base, so live
-- duplicates can exist. Failing here would stop the gateway from booting, and retiring live listings would
-- break buyers without the sellers' say. So no row changes state: per base, the live listing created first
-- (else the oldest) keeps the base, and the others are flagged base_legacy_duplicate and left out of the
-- index. Operators find them with: select id, seller_id, state from apis where base_legacy_duplicate;
-- New rows are never flagged, so a new listing of a taken base is always refused.
with ranked as (
  select id, row_number() over (
           partition by base_origin, base_path
           order by (state = 'live') desc, created_at, id) as n
  from apis
  where state in ('ownership_verified', 'rule_built', 'priced', 'registering', 'live')
)
update apis set base_legacy_duplicate = true
from ranked
where ranked.id = apis.id and ranked.n > 1;

create unique index apis_active_base_uniq on apis (base_origin, base_path)
  where state in ('ownership_verified', 'rule_built', 'priced', 'registering', 'live') and not base_legacy_duplicate;

-- The conflict check reads every active API on one origin.
create index apis_active_base_origin on apis (base_origin)
  where state in ('ownership_verified', 'rule_built', 'priced', 'registering', 'live');
