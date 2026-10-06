-- Audit C1: a payment is identified by its Cardano transaction, not by the JSON of the x402 payload
-- (the same transaction can be wrapped in many payload variants). Any earlier duplicates are exactly
-- that exploit: keep the oldest token per transaction and revoke the rest before enforcing uniqueness.
update credit_tokens c set status = 'revoked'
where c.tx_hash is not null and c.status <> 'revoked'
  and exists (
    select 1 from credit_tokens o
    where o.tx_hash = c.tx_hash and o.status <> 'revoked' and (o.created_at, o.id) < (c.created_at, c.id)
  );
create unique index credit_tokens_tx_hash_live on credit_tokens (tx_hash) where tx_hash is not null and status <> 'revoked';

-- Audit C2: recovery proves ownership with a secret only the buyer knows (its sha256 is sent with the
-- paid request); the payment itself is public on-chain and proves nothing.
alter table credit_tokens add column recovery_hash text;
