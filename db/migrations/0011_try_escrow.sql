-- "Try it live" buys escrow packs (PACK_MODE=escrow). The demo wallet is the buyer, so the row keeps what the
-- buyer side needs: the channel, the IOU key (secret, server-side only, like the token) and the promise the
-- lock was made for. iou_verified counts passes checked against that promise; an IOU is never signed above it.
alter table try_tokens
  add column channel_id text,
  add column iou_secret text,
  add column rule_hash text,
  add column iou_verified int not null default 0,
  add column iou_signed int not null default 0,
  add column iou_last text,
  add column disputed boolean not null default false,
  add check ((channel_id is null) = (iou_secret is null));
