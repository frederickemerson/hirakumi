-- 0007_ask_requests.sql: the "Ask Hirakumi" assistant (apps/web /api/ask) is rate limited per caller.
-- One row per accepted question. Counted in Postgres so the limit holds across every serverless instance.
-- `bucket` is "seller:<id>" for a signed-in caller, otherwise "ip:<sha256 of the address>" (no raw IPs stored).
-- Rows older than the window are deleted as new questions arrive.
create table ask_requests (
  id bigserial primary key,
  bucket text not null,
  created_at timestamptz not null default now()
);
create index on ask_requests (bucket, created_at);
create index on ask_requests (created_at);
