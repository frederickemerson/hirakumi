-- PACK_MODE=hybrid: the settlement a 402 offered (direct or escrow, and why), kept so the paid retry gets the
-- same answer. x402 matches `extra` by deep equality, and the inputs (uptime, listing age) change over time.
-- One row per (api, pack, receipt key, refund address, price); it lives as long as a quote.
create table settlement_decisions (
  decision_key text primary key,                 -- sha256(apiId|packId|receiptKey|refundAddress|priceMicros)
  api_id text not null references apis(id),
  pack_id text not null references packs(id),
  mode text not null check (mode in ('direct', 'escrow')),
  reasons jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index settlement_decisions_expires on settlement_decisions (expires_at);
