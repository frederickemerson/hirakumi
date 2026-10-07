-- Wallet sign-in and seller sessions (apps/web lib/session.ts, lib/repo/sessions.ts).

-- A signed sign-in works once. The verify route inserts the nonce of the signed message in the same transaction that
-- opens the session; a second insert of the same nonce conflicts and is refused. A row is only needed until the
-- nonce expires (5 minutes, after which the signed message is refused anyway), so expired rows are deleted a few at a
-- time on later sign-ins.
create table if not exists used_login_nonces (
  nonce text primary key,
  expires_at timestamptz not null
);
create index if not exists used_login_nonces_expires on used_login_nonces (expires_at);

-- Sessions are signed tokens (7 days) with an id (jti). Signing out records the id here, and every session check
-- looks it up, so a copied cookie stops working at logout. A row is only needed until the token expires. Deleting a
-- seller deletes its rows: the session check also requires the seller to exist, so those tokens stay refused.
create table if not exists revoked_sessions (
  jti text primary key,
  seller_id text not null references sellers(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists revoked_sessions_expires on revoked_sessions (expires_at);
