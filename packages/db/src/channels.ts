// Escrow pack channels: quotes, channel rows, and the IOU gate's leases.
import type { Sql } from "./client";

export type QuoteRow = {
  quote_key: string; channel_id: string; api_id: string; pack_id: string; receipt_key: string; refund_address: string;
  seller_address: string; fee_address: string; fee_bps: number; price_micros: string; price_per_call_micros: string;
  max_calls: number; unsigned_allowance: number; contest_period_ms: string; close_fee_budget_lovelace: string;
  datum_cbor: string; expires_at: Date; consumed_at: Date | null;
};

export type QuoteInsert = Omit<QuoteRow, "expires_at" | "consumed_at"> & { ttlSeconds: number };

/**
 * The live quote for this key, or `fresh` (built lazily, so a reuse never derives a new channel id) inserted in
 * its place when none is live. Live = not consumed and not expired.
 */
export async function getOrCreateQuote(sql: Sql, key: string, fresh: () => QuoteInsert): Promise<QuoteRow> {
  return sql.begin(async (tx) => {
    const [live] = await tx<QuoteRow[]>`
      select * from pack_quotes where quote_key = ${key} and consumed_at is null and expires_at > now() for update`;
    if (live) return live;
    const q = fresh();
    const [row] = await tx<QuoteRow[]>`
      insert into pack_quotes (quote_key, channel_id, api_id, pack_id, receipt_key, refund_address, seller_address, fee_address,
        fee_bps, price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms,
        close_fee_budget_lovelace, datum_cbor, expires_at)
      values (${key}, ${q.channel_id}, ${q.api_id}, ${q.pack_id}, ${q.receipt_key}, ${q.refund_address}, ${q.seller_address},
        ${q.fee_address}, ${q.fee_bps}, ${q.price_micros}, ${q.price_per_call_micros}, ${q.max_calls}, ${q.unsigned_allowance},
        ${q.contest_period_ms}, ${q.close_fee_budget_lovelace}, ${q.datum_cbor}, now() + (${q.ttlSeconds} * interval '1 second'))
      on conflict (quote_key) do update set
        channel_id = excluded.channel_id, receipt_key = excluded.receipt_key, refund_address = excluded.refund_address,
        seller_address = excluded.seller_address, fee_address = excluded.fee_address, fee_bps = excluded.fee_bps,
        price_micros = excluded.price_micros, price_per_call_micros = excluded.price_per_call_micros,
        max_calls = excluded.max_calls, unsigned_allowance = excluded.unsigned_allowance,
        contest_period_ms = excluded.contest_period_ms, close_fee_budget_lovelace = excluded.close_fee_budget_lovelace,
        datum_cbor = excluded.datum_cbor, expires_at = excluded.expires_at, consumed_at = null, created_at = now()
      where pack_quotes.consumed_at is not null or pack_quotes.expires_at <= now()
      returning *`;
    if (row) return row;
    // A concurrent 402 for the same key inserted first: its quote stands, so both 402s offer one datum.
    const [winner] = await tx<QuoteRow[]>`
      select * from pack_quotes where quote_key = ${key} and consumed_at is null and expires_at > now()`;
    if (!winner) throw new Error(`quote ${key} vanished`);
    return winner;
  });
}

export type ChannelStatus = "pending" | "locked" | "close_requested" | "closing" | "settled" | "refused";
export type ChannelRow = {
  channel_id: string; api_id: string; pack_id: string; credit_token_id: string; receipt_key: string; refund_address: string;
  seller_address: string; fee_address: string; fee_bps: number; price_micros: string; price_per_call_micros: string;
  max_calls: number; unsigned_allowance: number; contest_period_ms: string; close_fee_budget_lovelace: string;
  datum_cbor: string; status: ChannelStatus; refused_reason: string | null; lock_tx_hash: string; lock_output_index: number | null;
  utxo_tx_hash: string | null; utxo_output_index: number | null; passes_served: number; iou_accepted: number;
  iou_signature: string | null; onchain_accepted: number | null; contest_end_ms: string | null; close_tx_hash: string | null;
  raise_tx_hashes: string[]; settle_tx_hash: string | null; seller_paid_micros: string | null; fee_paid_micros: string | null;
  buyer_refund_micros: string | null; last_action_at: Date | null; created_at: Date; updated_at: Date;
};

/** Paid: consume the quote and open the channel (status pending until the lock is verified on-chain). */
export async function openChannelFromQuote(
  sql: Sql, p: { quoteKey: string; channelId: string; creditTokenId: string; lockTxHash: string },
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [q] = await tx<QuoteRow[]>`
      update pack_quotes set consumed_at = now()
      where quote_key = ${p.quoteKey} and channel_id = ${p.channelId} and consumed_at is null
      returning *`;
    if (!q) return false;
    await tx`
      insert into pack_channels (channel_id, api_id, pack_id, credit_token_id, receipt_key, refund_address, seller_address,
        fee_address, fee_bps, price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms,
        close_fee_budget_lovelace, datum_cbor, status, lock_tx_hash)
      values (${q.channel_id}, ${q.api_id}, ${q.pack_id}, ${p.creditTokenId}, ${q.receipt_key}, ${q.refund_address},
        ${q.seller_address}, ${q.fee_address}, ${q.fee_bps}, ${q.price_micros}, ${q.price_per_call_micros}, ${q.max_calls},
        ${q.unsigned_allowance}, ${q.contest_period_ms}, ${q.close_fee_budget_lovelace}, ${q.datum_cbor}, 'pending', ${p.lockTxHash})`;
    return true;
  });
}

export async function getChannel(sql: Sql, channelId: string): Promise<ChannelRow | null> {
  const [row] = await sql<ChannelRow[]>`select * from pack_channels where channel_id = ${channelId}`;
  return row ?? null;
}

export async function getChannelByLockTx(sql: Sql, txHash: string): Promise<ChannelRow | null> {
  const [row] = await sql<ChannelRow[]>`select * from pack_channels where lock_tx_hash = ${txHash} order by created_at limit 1`;
  return row ?? null;
}

export async function getChannelByToken(sql: Sql, apiId: string, tokenHash: string): Promise<ChannelRow | null> {
  const [row] = await sql<ChannelRow[]>`
    select ch.* from pack_channels ch join credit_tokens ct on ct.id = ch.credit_token_id
    where ct.token_hash = ${tokenHash} and ct.api_id = ${apiId}`;
  return row ?? null;
}

export type ChannelPage = { after?: { createdAt: Date; channelId: string }; limit?: number };
export const CHANNEL_PAGE_LIMIT = 200;

/**
 * One page of channels in these statuses, oldest first. Finding G2: callers that must see every channel
 * loop with `after` = the last row's (created_at, channel_id) until a page comes back shorter than `limit`.
 * The key is truncated to milliseconds (what a JS Date holds), so the cursor round-trips exactly.
 */
export async function listChannels(sql: Sql, statuses: ChannelStatus[], page: ChannelPage = {}): Promise<ChannelRow[]> {
  const limit = page.limit ?? CHANNEL_PAGE_LIMIT;
  const after = page.after
    ? sql`and (date_trunc('milliseconds', created_at), channel_id) > (${page.after.createdAt}::timestamptz, ${page.after.channelId})`
    : sql``;
  return sql<ChannelRow[]>`
    select * from pack_channels where status = any(${statuses}) ${after}
    order by date_trunc('milliseconds', created_at), channel_id limit ${limit}`;
}

/** Every channel in these statuses, page by page. */
export async function* allChannels(sql: Sql, statuses: ChannelStatus[], limit = CHANNEL_PAGE_LIMIT): AsyncGenerator<ChannelRow> {
  let after: ChannelPage["after"];
  for (;;) {
    const rows = await listChannels(sql, statuses, { after, limit });
    yield* rows;
    if (rows.length < limit) return;
    const last = rows[rows.length - 1]!;
    after = { createdAt: last.created_at, channelId: last.channel_id };
  }
}

/**
 * Finding G2: a paid channel whose lock never showed up on-chain (never verified) is refused after
 * `olderThanSeconds`, so dead locks don't pile up in the pending pass. Verified-then-rolled-back channels
 * (lock_output_index set) are not touched. With `onlyIds`, only those channels can expire: the watcher passes
 * the ones the chain positively reported as unknown in this tick, so a chain-API outage never refuses a lock
 * that is really on-chain. Returns the channel ids it refused.
 */
export async function expireUnseenLocks(sql: Sql, olderThanSeconds = 3600, onlyIds?: string[]): Promise<string[]> {
  if (onlyIds && onlyIds.length === 0) return [];
  const rows = await sql<{ channel_id: string }[]>`
    update pack_channels set status = 'refused', refused_reason = 'lock_never_seen', updated_at = now()
    where status = 'pending' and lock_output_index is null and created_at < now() - (${olderThanSeconds} * interval '1 second')
      ${onlyIds ? sql`and channel_id = any(${onlyIds})` : sql``}
    returning channel_id`;
  return rows.map((r) => r.channel_id);
}

/**
 * Finding G4: the verified lock tx is gone from the chain (rollback). The channel stops serving calls and goes
 * back to pending; the pending pass re-verifies it if the lock lands again. `lock_output_index` is kept, so
 * `expireUnseenLocks` leaves it alone.
 */
export async function revertChannelToPending(sql: Sql, channelId: string): Promise<boolean> {
  const rows = await sql`
    update pack_channels set status = 'pending', utxo_tx_hash = null, utxo_output_index = null, close_tx_hash = null,
      raise_tx_hashes = '{}', onchain_accepted = null, contest_end_ms = null, updated_at = now()
    where channel_id = ${channelId} and status in ('locked', 'close_requested', 'closing')
    returning channel_id`;
  return rows.length === 1;
}

/**
 * Finding G4: a Close was rolled back and the pack sits Open at `at` again. A Close the watcher submitted itself
 * (it stamps `last_action_at`, and a Close is its first action on a channel) answered a close request, so the
 * channel goes back to `close_requested` and the watcher closes again. A Close the buyer made directly reopens
 * the channel as `locked`, usable again.
 */
export async function reopenChannel(sql: Sql, channelId: string, at: { txHash: string; index: number }): Promise<boolean> {
  const rows = await sql`
    update pack_channels set status = case when last_action_at is not null then 'close_requested' else 'locked' end, utxo_tx_hash = ${at.txHash}, utxo_output_index = ${at.index}, close_tx_hash = null,
      raise_tx_hashes = '{}', onchain_accepted = null, contest_end_ms = null, updated_at = now()
    where channel_id = ${channelId} and status = 'closing'
    returning channel_id`;
  return rows.length === 1;
}

/** Optional cleanup: unpaid quotes a day past their expiry. */
export async function deleteStaleQuotes(sql: Sql, olderThanSeconds = 86_400): Promise<number> {
  const rows = await sql`
    delete from pack_quotes where consumed_at is null and expires_at < now() - (${olderThanSeconds} * interval '1 second')
    returning quote_key`;
  return rows.length;
}

/** The lock passed verification: the channel is usable and its credit token goes live. */
export async function markChannelLocked(sql: Sql, channelId: string, outputIndex: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ credit_token_id: string }[]>`
      update pack_channels set status = 'locked', lock_output_index = ${outputIndex}, utxo_tx_hash = lock_tx_hash,
        utxo_output_index = ${outputIndex}, updated_at = now()
      where channel_id = ${channelId} and status = 'pending'
      returning credit_token_id`;
    if (!row) return false;
    await tx`update credit_tokens set status = 'active' where id = ${row.credit_token_id} and status = 'pending'`;
    return true;
  });
}

/** The lock failed verification. The token never activates; the reason is public on the channel page. */
export async function markChannelRefused(sql: Sql, channelId: string, reason: string): Promise<void> {
  await sql`
    update pack_channels set status = 'refused', refused_reason = ${reason}, updated_at = now()
    where channel_id = ${channelId} and status = 'pending'`;
}

export async function requestClose(sql: Sql, channelId: string): Promise<ChannelStatus | null> {
  const [row] = await sql<{ status: ChannelStatus }[]>`
    update pack_channels set status = case when status = 'locked' then 'close_requested' else status end, updated_at = now()
    where channel_id = ${channelId} returning status`;
  return row?.status ?? null;
}

export async function updateChannel(sql: Sql, channelId: string, fields: Partial<ChannelRow>): Promise<void> {
  const cols = Object.keys(fields) as (keyof ChannelRow)[];
  if (!cols.length) return;
  await sql`update pack_channels set ${sql(fields as never, cols as never)}, updated_at = now() where channel_id = ${channelId}`;
}

// ---------------------------------------------------------------- the IOU gate

export type GateResult =
  | { ok: true; tokenId: string; remainingAfter: number; channel: ChannelRow }
  | { ok: false; reason: "not_found" | "pending" | "revoked" | "exhausted" | "closing" | "iou_required"; channel?: ChannelRow };

/**
 * One transaction: lock the channel row, (optionally) record a newer verified IOU, check the unsigned
 * allowance against live leases, reserve a credit, add a lease. Concurrent calls serialise on the row lock,
 * so two calls can never both use the last unsigned slot.
 *
 * `verifiedIou` must already be checked against the channel's key and `passes_served`.
 */
export async function gateChannelCall(
  sql: Sql,
  p: { channelId: string; callId: string; leaseSeconds: number; verifiedIou?: { accepted: number; signature: string } },
): Promise<GateResult> {
  return sql.begin(async (tx) => {
    const [ch] = await tx<ChannelRow[]>`select * from pack_channels where channel_id = ${p.channelId} for update`;
    if (!ch) return { ok: false, reason: "not_found" } as const;
    if (p.verifiedIou && p.verifiedIou.accepted > ch.iou_accepted && p.verifiedIou.accepted <= ch.passes_served) {
      await tx`update pack_channels set iou_accepted = ${p.verifiedIou.accepted}, iou_signature = ${p.verifiedIou.signature}, updated_at = now()
               where channel_id = ${ch.channel_id}`;
      ch.iou_accepted = p.verifiedIou.accepted;
      ch.iou_signature = p.verifiedIou.signature;
    }
    if (ch.status === "pending" || ch.status === "refused") return { ok: false, reason: "pending", channel: ch } as const;
    if (ch.status !== "locked") return { ok: false, reason: "closing", channel: ch } as const;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from channel_leases where channel_id = ${ch.channel_id} and expires_at > now()`;
    if (ch.passes_served + n - ch.iou_accepted >= ch.unsigned_allowance) return { ok: false, reason: "iou_required", channel: ch } as const;
    const [t] = await tx<{ id: string; remaining: number }[]>`
      update credit_tokens set remaining = remaining - 1
      where id = ${ch.credit_token_id} and status = 'active' and remaining > 0
      returning id, remaining`;
    if (!t) {
      const [s] = await tx<{ status: string }[]>`select status from credit_tokens where id = ${ch.credit_token_id}`;
      return { ok: false, reason: s?.status === "revoked" ? "revoked" : s?.status === "pending" ? "pending" : "exhausted", channel: ch } as const;
    }
    await tx`insert into channel_leases (call_id, channel_id, expires_at)
             values (${p.callId}, ${ch.channel_id}, now() + (${p.leaseSeconds} * interval '1 second'))`;
    return { ok: true, tokenId: t.id, remainingAfter: t.remaining, channel: ch } as const;
  });
}

/** A call finished. A pass counts towards `passes_served`; either way the lease goes. Returns the new count. */
export async function finishChannelCall(sql: Sql, p: { channelId: string; callId: string; passed: boolean }): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`delete from channel_leases where call_id = ${p.callId}`;
    const [row] = await tx<{ passes_served: number }[]>`
      update pack_channels set passes_served = passes_served + ${p.passed ? 1 : 0}, updated_at = now()
      where channel_id = ${p.channelId} returning passes_served`;
    return row.passes_served;
  });
}

/** Records a verified IOU outside a call (e.g. the close route). Never lowers the stored count. */
export async function recordIou(sql: Sql, channelId: string, accepted: number, signature: string): Promise<void> {
  await sql`update pack_channels set iou_accepted = ${accepted}, iou_signature = ${signature}, updated_at = now()
            where channel_id = ${channelId} and iou_accepted < ${accepted} and passes_served >= ${accepted}`;
}
