-- One-time links for the wallet steps of a Sokosumi task (/act/<token>): prove ownership (with the optional key),
-- save the API's key, approve publishing. Every statement can run again.
--
-- The token only selects the action; the API owner's wallet signature on the page is the authority, so a leaked
-- link can do nothing. Only a SHA-256 hash of the token is stored. A token is bound to one API and one action,
-- expires (30 minutes) and is used once (used_at). wallet: the owner's address when the link was made, which the
-- comment names.
create table if not exists act_tokens (
  id text primary key,
  token_hash text not null unique,
  api_id text not null references apis(id) on delete cascade,
  action text not null check (action in ('ownership', 'key', 'publish')),
  wallet text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists act_tokens_api_idx on act_tokens (api_id);
