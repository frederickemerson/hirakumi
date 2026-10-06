-- Finding G6: a MIP-003 result is submitted once. A runner claims the submit before calling Masumi, so a
-- second gateway instance (or the next tick) never re-submits while the first is still submitting.
-- A claim older than the stale window (a runner that died mid-submit) can be taken over.
alter table jobs add column submit_claimed_at timestamptz;
