-- The leak check: can a stranger call this API for free, without the seller's key? Every statement can run again.
--
-- exposure: 'unknown' (never checked, or the last check could not reach the API), 'open' (an endpoint answered a
-- good 2xx without the key, so nobody would pay through Hirakumi) or 'protected' (every endpoint refused without
-- the key: 401, 402, 403 or 407). Publishing requires 'protected'. Listings already live keep running whatever this
-- says; the column starts at 'unknown' for them.
alter table apis add column if not exists exposure text not null default 'unknown';
alter table apis add column if not exists exposure_checked_at timestamptz;
alter table apis drop constraint if exists apis_exposure_check;
alter table apis add constraint apis_exposure_check check (exposure in ('unknown', 'open', 'protected'));
