-- 0005_coworker_replies.sql: the seller coworker reads replies on its Sokosumi tasks.
-- One row per task event the coworker has handled (a seller comment it acted on or deliberately ignored).
-- The insert is the dedupe: an event is acted on at most once, across restarts.
create table coworker_task_events (
  event_id text primary key,                   -- Sokosumi task event id
  task_id text not null references coworker_tasks(task_id),
  handled_at timestamptz not null default now()
);
create index on coworker_task_events (task_id);
