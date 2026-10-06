-- Ownership proof by a field in the seller's OpenAPI file (replaces the /.well-known/hirakumi/<api>.txt file).
-- kind 'openapi': token is the API's verification code (hkv_ + 32 random bytes, base64url). The seller puts
-- it at the root of their OpenAPI document as `x-hirakumi-verify`. 'http' stays allowed for old rows.
alter table challenges drop constraint challenges_kind_check;
alter table challenges add constraint challenges_kind_check check (kind in ('http', 'wallet', 'openapi'));
-- A code is never reused: no two APIs (and no two rows) can ever hold the same one.
create unique index challenges_openapi_token_uniq on challenges (token) where kind = 'openapi';
-- At most one open code per API, so the code the seller copied stays the code we check.
create unique index challenges_openapi_open_per_api on challenges (api_id) where kind = 'openapi' and consumed_at is null;
