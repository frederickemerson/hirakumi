-- The Hirakumi front door: a seller points their API's public hostname (api.seller.com) at Hirakumi, and the
-- gateway answers it by Host. Callers without a pack get the 402 offer; the gateway calls the seller's API at its
-- new origin (origin.seller.com, apis.origin). Every statement can run again.

-- One row per public hostname. status: pending_dns (created, TLS allowed, waiting for the seller's DNS change),
-- active (routed to Hirakumi and checked), detached (the seller stopped using it, or DNS no longer points here),
-- disabled (its _hirakumi TXT code is gone). Only pending_dns and active are served or get a certificate.
create table if not exists api_domains (
  host text primary key check (host = lower(host) and host !~ '^[0-9.]+$' and host like '%.%' and host !~ '[:/\s]'),
  seller_id text not null references sellers(id),
  status text not null check (status in ('pending_dns', 'active', 'detached', 'disabled')),
  txt_verified_at timestamptz,
  routed_at timestamptz,
  failures int not null default 0,
  next_check_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists api_domains_seller on api_domains (seller_id);
create index if not exists api_domains_created on api_domains (created_at);

-- apis.origin stays where the gateway calls. public_host is the customer-facing hostname, set while the front door
-- is in use; the public path of an operation is path_prefix + its path, as before.
alter table apis add column if not exists public_host text references api_domains(host) on delete set null;
create index if not exists apis_public_host on apis (public_host) where public_host is not null;
