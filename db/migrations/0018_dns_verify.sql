-- Ownership proof by a DNS TXT record (replaces the X-Hirakumi-Verify response header for new proofs).
-- Every statement can run again.

-- kind 'dns': token is the API's verification code (hkv_ + 32 random bytes, base64url). The seller adds it as a TXT
-- record named _hirakumi.<host>. 'header' stays allowed: APIs proven by header keep being re-checked by header.
alter table challenges drop constraint if exists challenges_kind_check;
alter table challenges add constraint challenges_kind_check check (kind in ('http', 'wallet', 'openapi', 'header', 'dns'));
-- A code is never reused: no two APIs (and no two rows) can ever hold the same one.
create unique index if not exists challenges_dns_token_uniq on challenges (token) where kind = 'dns';
-- At most one open code per API, so the code the seller copied stays the code we check.
create unique index if not exists challenges_dns_open_per_api on challenges (api_id) where kind = 'dns' and consumed_at is null;

-- A seller midway through the header proof keeps the code they saw; a header pass does not count for DNS.
update challenges set kind = 'dns', proof = null where kind = 'header' and consumed_at is null;
