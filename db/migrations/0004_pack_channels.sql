-- Escrow packs (PACK_MODE=escrow): the pack payment locks tUSDM at the pack_escrow script with an inline
-- datum; the buyer signs cumulative IOUs; Close / Raise / Settle pay out on-chain.

-- How many passing calls a buyer may receive before signing the next IOU. The seller's choice; off-chain only.
alter table packs add column unsigned_allowance int not null default 1;
alter table packs add constraint packs_unsigned_allowance_range check (unsigned_allowance >= 1 and unsigned_allowance <= calls);

-- A 402 offer's datum. Reused for the same (api, pack, receipt key, refund address) until it expires or is paid,
-- so the 402 and the paid retry carry byte-identical extra.datum.
create table pack_quotes (
  quote_key text primary key,                    -- sha256(apiId|packId|receiptKey|refundAddress)
  channel_id text not null unique,               -- 64 hex
  api_id text not null references apis(id),
  pack_id text not null references packs(id),
  receipt_key text not null,
  refund_address text not null,
  seller_address text not null,
  fee_address text not null,
  fee_bps int not null,
  price_micros bigint not null,
  price_per_call_micros bigint not null,
  max_calls int not null,
  unsigned_allowance int not null,               -- copied from packs: a later change doesn't touch sold packs
  contest_period_ms bigint not null,
  close_fee_budget_lovelace bigint not null,
  datum_cbor text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table pack_channels (
  channel_id text primary key,
  api_id text not null references apis(id),
  pack_id text not null references packs(id),
  credit_token_id text not null unique references credit_tokens(id),
  receipt_key text not null,
  refund_address text not null,
  seller_address text not null,
  fee_address text not null,
  fee_bps int not null,
  price_micros bigint not null,
  price_per_call_micros bigint not null,
  max_calls int not null,
  unsigned_allowance int not null,
  contest_period_ms bigint not null,
  close_fee_budget_lovelace bigint not null,
  datum_cbor text not null,
  -- pending: paid, lock not yet seen on-chain; locked: verified lock; close_requested: buyer asked or pack used up;
  -- closing: a Close is on-chain (Raise may follow); settled: paid out; refused: the lock failed verification.
  status text not null check (status in ('pending','locked','close_requested','closing','settled','refused')),
  refused_reason text,
  lock_tx_hash text not null,
  lock_output_index int,
  utxo_tx_hash text,                             -- where the pack sits now (lock, then Close / Raise outputs)
  utxo_output_index int,
  passes_served int not null default 0,
  iou_accepted int not null default 0,           -- highest IOU the buyer signed (verified)
  iou_signature text,
  onchain_accepted int,                          -- Closing.accepted as the chain shows it
  contest_end_ms bigint,
  close_tx_hash text,
  raise_tx_hashes text[] not null default '{}',
  settle_tx_hash text,
  seller_paid_micros bigint,
  fee_paid_micros bigint,
  buyer_refund_micros bigint,
  last_action_at timestamptz,                    -- watcher backoff after a submit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pack_channels_status on pack_channels (status);

-- One row per paid call in flight. A call that dies leaves a row that simply expires, so the allowance frees up.
create table channel_leases (
  call_id text primary key,
  channel_id text not null references pack_channels(channel_id) on delete cascade,
  expires_at timestamptz not null
);
create index channel_leases_channel on channel_leases (channel_id, expires_at);
