-- A first-time Sokosumi seller's intake (the OpenAPI link, or a base URL and example requests) waits here while they
-- link their wallet on the setup link; the coworker then starts onboarding from it without asking again. Cleared
-- when it is used. Every statement can run again.
alter table coworker_tasks add column if not exists pending_intake text;
