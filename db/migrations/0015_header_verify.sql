-- Ownership proof by a response header, and APIs given by example requests without an OpenAPI link.
-- Every statement can run again: a database that ran an earlier draft of 0014 with these changes in it gets the same
-- result, and so does one that ran 0014 as shipped.

-- APIs given by example requests (intake_kind 'samples') have no OpenAPI link, so openapi_url is NULL for them. 0014
-- stored the old proof file (<base folder>/hirakumi-verify.json) there, which the header proof below replaces.
-- An API given by its OpenAPI link always has one.
alter table apis alter column openapi_url drop not null;
update apis set openapi_url = null where intake_kind = 'samples' and openapi_url is not null;
alter table apis drop constraint if exists apis_openapi_url_for_openapi;
alter table apis add constraint apis_openapi_url_for_openapi check (intake_kind = 'samples' or openapi_url is not null);

-- kind 'header': token is the API's verification code (hkv_ + 32 random bytes, base64url). The seller's API sends
-- it as the X-Hirakumi-Verify response header at its base URL. 'openapi' and 'http' stay allowed for old rows.
alter table challenges drop constraint if exists challenges_kind_check;
alter table challenges add constraint challenges_kind_check check (kind in ('http', 'wallet', 'openapi', 'header'));
-- A code is never reused: no two APIs (and no two rows) can ever hold the same one.
create unique index if not exists challenges_header_token_uniq on challenges (token) where kind = 'header';
-- At most one open code per API, so the code the seller copied stays the code we check.
create unique index if not exists challenges_header_open_per_api on challenges (api_id) where kind = 'header' and consumed_at is null;

-- apis.upstream_auth (0014) is unchanged, but its sealed value is now "hks2...": bound to the API's id, placement and
-- name, origin and path prefix (@hirakumi/core upstreamAuth.ts), so a changed address means saving the key again.

-- Ownership re-check (apps/gateway monitor.ts): APIs proven with a 'header' code are checked again from time to time.
-- ownership_failures: checks in a row without the code (a network error neither counts nor resets). Two pause new
-- sales: ownership_paused_at and ownership_pause_reason are set until the header is back. ownership_next_check_at:
-- when the next check is due (jittered).
alter table apis add column if not exists ownership_failures int not null default 0;
alter table apis add column if not exists ownership_paused_at timestamptz;
alter table apis add column if not exists ownership_pause_reason text;
alter table apis add column if not exists ownership_next_check_at timestamptz;
