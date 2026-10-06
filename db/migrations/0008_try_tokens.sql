-- "Try it live": credit packs Hirakumi's demo buyer wallet bought for real on Cardano preprod, one row per
-- purchase attempt. The gateway writes it (POST /internal/demo/buy-pack/:apiId); the web's try route reads the
-- newest active token for an API. Attempts are also what the purchase limits count, so a row is written
-- before any payment is signed.
create table try_tokens (
  id text primary key,
  api_id text not null references apis(id),
  -- buying: in progress. active: the token works (or will once settled). unsettled: signed but the answer
  -- was lost, recoverable with payment_signature + recovery_secret. void: nothing was signed, nothing spent.
  -- failed: signed, not recoverable.
  status text not null check (status in ('buying', 'active', 'unsettled', 'void', 'failed')),
  token text,
  token_hash text,
  pack_id text references packs(id),
  tx_hash text,
  credits int,
  price_micros bigint,
  payment_signature text,
  recovery_secret text,
  error text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check (status <> 'active' or (token is not null and token_hash is not null))
);
create index try_tokens_api_created on try_tokens (api_id, created_at desc);
create index try_tokens_created on try_tokens (created_at);
