create table sellers (
  id text primary key,                         -- 'sel_' + 10 random base32
  cardano_addr text not null unique check (cardano_addr like 'addr_test1%'),
  sokosumi_user_id text,
  created_at timestamptz not null default now()
);
create table apis (
  id text primary key,                         -- 'api_' + 10 random base32
  seller_id text not null references sellers(id),
  name text not null,
  origin text not null,                        -- e.g. https://price.example.dev
  path_prefix text not null default '/',
  openapi_url text not null,
  openapi_sha256 text,
  state text not null default 'intake' check (state in
    ('intake','parsed','described','endpoints_confirmed','ownership_verified',
     'rule_built','priced','registering','live','retired')),
  health text not null default 'healthy' check (health in ('healthy','down')),
  health_checked_at timestamptz,
  escrow_op_id text,
  agent_identifier text,
  sokosumi_task_id text,
  created_at timestamptz not null default now()
);
create table onboard_steps (
  api_id text not null references apis(id),
  step text not null,
  status text not null check (status in ('pending','running','done','failed','waiting_seller')),
  attempts int not null default 0,
  output jsonb,
  updated_at timestamptz not null default now(),
  primary key (api_id, step)
);
create table challenges (
  id text primary key,
  api_id text not null references apis(id),
  kind text not null check (kind in ('http','wallet')),
  token text not null,                         -- http: file contents; wallet: nonce
  expires_at timestamptz not null,
  consumed_at timestamptz,
  proof jsonb
);
create table operations (
  id text primary key,                         -- 'op_' + 10 random base32
  api_id text not null references apis(id),
  op_id text not null,                         -- OpenAPI operationId (or METHOD_path slug)
  method text not null,
  path text not null,
  input_schema jsonb not null,
  description text,
  side_effects_likely boolean not null default false,
  side_effects_confirmed_none boolean not null default false,
  enabled boolean not null default false,
  unique (api_id, op_id)
);
create table rules (
  id text primary key,
  operation_id text not null references operations(id),
  version int not null,
  definition jsonb not null,                   -- RuleDefinition
  hash text not null,                          -- 'sha256:<hex>' of jcs(definition); identical rules may repeat
  plain_english text,
  created_at timestamptz not null default now(),
  unique (operation_id, version)
);
create table packs (
  id text primary key,                         -- 'pk_' + 10 random base32
  api_id text not null references apis(id),
  calls int not null check (calls > 0),
  price_micros bigint not null check (price_micros >= 1000000),
  escrow_price_micros bigint not null check (escrow_price_micros >= 1000000)
);
create table credit_tokens (
  id text primary key,
  api_id text not null references apis(id),
  pack_id text not null references packs(id),
  token_hash text not null unique,             -- sha256 hex of the bearer token
  payer text,
  status text not null check (status in ('pending','active','exhausted','revoked')),
  remaining int not null,
  payment_payload_hash text not null unique,
  tx_hash text,
  created_at timestamptz not null default now()
);
create table calls (
  id text primary key,
  kind text not null check (kind in ('credit','escrow','probe','preview')),
  credit_token_id text references credit_tokens(id),
  job_id text,
  blockchain_id text,
  api_id text not null references apis(id),
  op_id text not null,
  rule_id text references rules(id),
  execution text not null check (execution in ('upstream_ok','upstream_error','timeout','blocked')),
  verdict text not null check (verdict in ('pass','fail','n/a')),
  verdict_reasons jsonb not null default '[]',
  latency_ms int,
  input_hash text,
  output_hash text,
  created_at timestamptz not null default now()
);
create table jobs (
  id text primary key,                         -- MIP-003 job_id
  api_id text not null references apis(id),
  identifier_from_purchaser text not null,
  input jsonb not null,
  input_hash text not null,
  blockchain_identifier text,
  status text not null check (status in
    ('awaiting_payment','running','completed','failed','expired')),
  output text,
  output_hash text,
  failure_reasons jsonb,
  pay_by_time timestamptz,
  submit_result_time timestamptz,
  created_at timestamptz not null default now()
);
create table test_inputs (
  id text primary key,
  operation_id text not null references operations(id),
  input jsonb not null
);
create table health_events (
  id bigserial primary key,
  api_id text not null references apis(id),
  from_health text not null,
  to_health text not null,
  reasons jsonb not null default '[]',
  at timestamptz not null default now(),
  notified_at timestamptz
);
create index on rules (hash);
create index on calls (api_id, created_at desc);
create index on health_events (notified_at) where notified_at is null;
