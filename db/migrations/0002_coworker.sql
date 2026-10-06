-- 0002_coworker.sql — owned by P3 (contract addition, announced to all owners).
-- P2 reads/writes `messages` for the dashboard chat; it must NOT add its own messages table.

-- One row per Sokosumi task assigned to the coworker. The insert is the durable "seen" marker.
create table coworker_tasks (
  task_id text primary key,                    -- Sokosumi task id (tsk_...)
  sokosumi_user_id text not null,              -- task.userId: who is billed via /coworkers/me/usage
  sokosumi_organization_id text,               -- task.organizationId (nullable)
  task_name text not null,
  setup_token text not null unique,            -- WEB_BASE_URL/setup?t=<setup_token>; web resolves it to the task
  usage_reported_at timestamptz,               -- onboarding fee billed (once per task)
  created_at timestamptz not null default now()
);

-- Coworker <-> seller conversation. Always the dashboard-chat log; additionally delivered to the
-- Sokosumi task when task_id is set and the coworker runs in Sokosumi mode.
create table messages (
  id bigserial primary key,
  api_id text references apis(id),             -- null for the setup-link message (no API yet)
  seller_id text references sellers(id),       -- contract v1.1: P2 threads the dashboard chat by seller
  task_id text,                                -- Sokosumi task id; null = dashboard only
  author text not null check (author in ('coworker', 'seller')),
  body text not null,                          -- plain English, shown verbatim
  task_status text check (task_status in ('RUNNING', 'INPUT_REQUIRED', 'COMPLETED', 'FAILED')),
  dedupe_key text unique,                      -- same key = same message (idempotent enqueue)
  created_at timestamptz not null default now(),
  delivered_at timestamptz,                    -- posted to Sokosumi
  delivery_attempts int not null default 0,
  last_error text,
  handled_at timestamptz                       -- contract v1.1: set by the coworker once it has acted on a seller message
);
create index on messages (api_id, id);
create index on messages (seller_id, api_id, id);
create index on messages (id) where author = 'seller' and handled_at is null;
create index on messages (id) where delivered_at is null and task_id is not null;

-- rules.hash uniqueness was removed in 0001 itself (contract v1.1), so no fix is needed here.
