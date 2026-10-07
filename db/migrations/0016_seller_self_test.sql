-- Seller "Try it live": a seller tests their own live API from the dashboard.
-- The first test per listing is free (Hirakumi's demo wallet buys the pack, as on the showcase API); after that the
-- seller's own wallet pays. Packs bought either way are self tests: never sales, earnings or reputation.

-- The seller a free test was bought for; null for the public showcase ("Try it live" on TRY_LIVE_APIS).
alter table try_tokens add column self_test_seller_id text references sellers(id);

-- One free test per listing, ever. Only an attempt that spent nothing (void) frees the slot again. The gateway
-- checks the per-seller cap under the same advisory lock as the purchase limits (packages/db tryTokens.ts).
create unique index try_tokens_one_free_test on try_tokens (api_id) where self_test_seller_id is not null and status <> 'void';
create index try_tokens_self_test_seller on try_tokens (self_test_seller_id) where self_test_seller_id is not null;
create index try_tokens_token_hash on try_tokens (token_hash) where token_hash is not null;

-- Packs the seller bought for their own API with their own wallet from the dashboard (x402, settled direct).
-- The bearer token stays server-side, like try_tokens.token.
create table self_test_packs (
  id text primary key,
  api_id text not null references apis(id),
  seller_id text not null references sellers(id),
  token text not null,
  token_hash text not null unique,
  tx_hash text,
  credits int not null,
  created_at timestamptz not null default now()
);
create index self_test_packs_api on self_test_packs (api_id, created_at desc);

-- Every credit token that is a self test: paid from the API's own payout address (direct payer, or the refund
-- address of an escrow pack), a free test, or a pack bought through the seller's own Try it live.
-- Sales, earnings, sold counts and pass rates leave these out.
create view self_test_credit_tokens as
select t.id as credit_token_id, t.api_id
from credit_tokens t
join apis a on a.id = t.api_id
join sellers s on s.id = a.seller_id
where t.payer = s.cardano_addr
   or exists (select 1 from pack_channels pc where pc.credit_token_id = t.id and pc.refund_address = s.cardano_addr)
   or exists (select 1 from try_tokens y where y.token_hash = t.token_hash and y.api_id = t.api_id and y.self_test_seller_id is not null)
   or exists (select 1 from self_test_packs x where x.token_hash = t.token_hash and x.api_id = t.api_id);

-- Try it live's per-pack hourly call budget, reserved before each call goes to the gateway (the calls log is only
-- written after the call, so counting it let concurrent tries overspend). One row per reserved try; a try that
-- never reached the gateway deletes its row. Counted under an advisory lock per credit token (lib/try-repo.ts).
create table try_call_slots (
  id bigserial primary key,
  credit_token_id text not null references credit_tokens(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index try_call_slots_token_created on try_call_slots (credit_token_id, created_at);
