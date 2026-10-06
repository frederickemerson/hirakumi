-- Any API, not just OpenAPI. intake_kind 'samples': the seller gave a base URL and example requests instead of an
-- OpenAPI file. samples = {"base": "<base url>", "lines": "<example requests, one per line>"}; the coworker's parse
-- step builds an OpenAPI document from them (@hirakumi/core samples.ts). These APIs have no OpenAPI link, so
-- openapi_url is NULL for them. An API given by its OpenAPI link always has one.
alter table apis
  add column intake_kind text not null default 'openapi' check (intake_kind in ('openapi', 'samples')),
  add column samples jsonb,
  alter column openapi_url drop not null,
  add constraint apis_samples_match_kind check ((intake_kind = 'samples') = (samples is not null)),
  add constraint apis_openapi_url_for_openapi check (intake_kind = 'samples' or openapi_url is not null);

-- Ownership proof by a response header (replaces the code in the OpenAPI file, kind 'openapi', from 0009).
-- kind 'header': token is the API's verification code (hkv_ + 32 random bytes, base64url). The seller's API sends
-- it as the X-Hirakumi-Verify response header at its base URL. 'openapi' and 'http' stay allowed for old rows.
alter table challenges drop constraint challenges_kind_check;
alter table challenges add constraint challenges_kind_check check (kind in ('http', 'wallet', 'openapi', 'header'));
-- A code is never reused: no two APIs (and no two rows) can ever hold the same one.
create unique index challenges_header_token_uniq on challenges (token) where kind = 'header';
-- At most one open code per API, so the code the seller copied stays the code we check.
create unique index challenges_header_open_per_api on challenges (api_id) where kind = 'header' and consumed_at is null;

-- APIs that need a key. upstream_auth = {"in": "header"|"query", "name": "...", "sealed": "hks2....", "hint": "abcd"}.
-- sealed is the key encrypted to the gateway's public key and bound to this API's id, placement and name, origin and
-- path prefix (@hirakumi/core upstreamAuth.ts), so a changed address means saving the key again;
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
