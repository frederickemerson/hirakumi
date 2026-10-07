-- Any API, not just OpenAPI. intake_kind 'samples': the seller gave a base URL and example requests instead of an
-- OpenAPI file. samples = {"base": "<base url>", "lines": "<example requests, one per line>"}; the coworker's parse
-- step builds an OpenAPI document from them (@hirakumi/core samples.ts). For these APIs openapi_url is the
-- ownership proof file, <base folder>/hirakumi-verify.json, which the gateway reads like an OpenAPI file.
alter table apis
  add column intake_kind text not null default 'openapi' check (intake_kind in ('openapi', 'samples')),
  add column samples jsonb,
  add constraint apis_samples_match_kind check ((intake_kind = 'samples') = (samples is not null));

-- APIs that need a key. upstream_auth = {"in": "header"|"query", "name": "...", "sealed": "hks1....", "hint": "abcd"}.
-- sealed is the key encrypted to the gateway's public key and bound to this API's id (@hirakumi/core upstreamAuth.ts);
-- only the gateway can open it. hint is the last 4 characters (empty for short keys), for display only.
alter table apis add column upstream_auth jsonb;

-- api.example.com. (trailing dot) is the same host as api.example.com, so base_origin drops the dot too
-- (@hirakumi/core listingBase.ts normalizeOrigin). A generated column's expression can't be changed in place on every
-- Postgres version, so it is dropped and added again; dropping it drops the two indexes from 0010, recreated below.
alter table apis drop column base_origin;
alter table apis add column base_origin text generated always as (
  regexp_replace(
    regexp_replace(regexp_replace(lower(rtrim(origin, '/')), '^(https://[^/]+):443$', '\1'), '^(http://[^/]+):80$', '\1'),
    '^(https?://[^/:]*[^/:.])\.+(:[0-9]+)?$', '\1\2')
) stored;

-- Rows that only now share an active base (one listed with the dot, one without) are flagged like 0010 did, so the
-- index can be built: the live listing created first (else the oldest) keeps the base.
with ranked as (
  select id, row_number() over (
           partition by base_origin, base_path
           order by (state = 'live') desc, created_at, id) as n
  from apis
  where state in ('ownership_verified', 'rule_built', 'priced', 'registering', 'live') and not base_legacy_duplicate
)
update apis set base_legacy_duplicate = true
from ranked
where ranked.id = apis.id and ranked.n > 1;

create unique index apis_active_base_uniq on apis (base_origin, base_path)
  where state in ('ownership_verified', 'rule_built', 'priced', 'registering', 'live') and not base_legacy_duplicate;

create index apis_active_base_origin on apis (base_origin)
  where state in ('ownership_verified', 'rule_built', 'priced', 'registering', 'live');
