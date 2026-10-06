// ChannelWatcher: follows every escrow pack on-chain and acts for the seller.
//  - pending channels: verify the lock (datum bytes, address, price, nothing but lovelace + the pack asset)
//  - follows each pack UTxO through Close / Raise / Settle, whoever submitted them
//  - Open and (buyer asked to close, or every call served) → Close with the latest IOU
//  - Closing with an older count than our latest IOU → Raise, while ≥ raiseMargin of the contest is left
//  - after contest_end → Settle
// Without an operator key it only verifies and observes.
import {
  allChannels, deleteStaleDecisions, deleteStaleQuotes, expireUnseenLocks, getChannel, reopenChannel, revertChannelToPending, updateChannel,
  type ChannelRow, type ChannelStatus, type Sql,
} from "@hirakumi/db";
import { decodePackDatum, type ChainOutput } from "@hirakumi/escrow";
import type { PackEscrowConfig } from "./config";
import type { EscrowChain, Outref } from "./escrowChain";
import { PACK_UNIT, verifyChannelLock } from "./escrowPacks";

const ACTION_BACKOFF_MS = 90_000;
const tagOf = (channelId: string) => `5820${channelId}`;
const LIVE: ChannelStatus[] = ["locked", "close_requested", "closing"];
/** A paid lock that never showed up on-chain within this long is refused (finding G2). */
const UNSEEN_LOCK_EXPIRY_SECONDS = 3600;
const sameRef = (a: Outref, b: Outref) => a.txHash === b.txHash && a.index === b.index;

type Live = { at: Outref; stage: { kind: "open" } | { kind: "closing"; accepted: number; contestEnd: number } };
type Followed = { kind: "live"; live: Live } | { kind: "settled" } | { kind: "unknown" };

export type WatchEvent = { channelId: string; action: "verified" | "refused" | "close" | "raise" | "settle" | "settled"; tx?: string };

export class ChannelWatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly d: { sql: Sql; chain: EscrowChain; config: PackEscrowConfig; intervalMs?: number }) {}

  start(): void {
    this.timer = setInterval(() => { void this.tick().catch((e) => console.error("[watcher]", e)); }, this.d.intervalMs ?? 20_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<WatchEvent[]> {
    if (this.running) return [];
    this.running = true;
    const events: WatchEvent[] = [];
    try {
      // Finding G2: every channel, page by page (a fixed first page let 200 old rows hide newer ones).
      // Only channels the chain positively reported as unknown may expire; an API error proves nothing.
      const confirmedUnseen: string[] = [];
      for await (const ch of allChannels(this.d.sql, ["pending"])) {
        const v = await verifyChannelLock(this.d.sql, this.d.chain, ch).catch((e) => {
          console.error(`[watcher] verify ${ch.channel_id}:`, (e as Error).message);
          return "error" as const;
        });
        if (v === "unseen") confirmedUnseen.push(ch.channel_id);
        if (v === "locked") events.push({ channelId: ch.channel_id, action: "verified" });
        if (v === "refused") events.push({ channelId: ch.channel_id, action: "refused" });
      }
      // After the verification pass, so a watcher that was down still verifies locks that landed meanwhile.
      for (const id of await expireUnseenLocks(this.d.sql, UNSEEN_LOCK_EXPIRY_SECONDS, confirmedUnseen)) {
        console.warn(`[watcher] channel ${id}: lock never seen on-chain, refused`);
        events.push({ channelId: id, action: "refused" });
      }
      await deleteStaleQuotes(this.d.sql).catch((e) => console.error("[watcher] quote cleanup:", (e as Error).message));
      await deleteStaleDecisions(this.d.sql).catch((e) => console.error("[watcher] settlement decision cleanup:", (e as Error).message));
      for await (const ch of allChannels(this.d.sql, LIVE)) {
        await this.watch(ch, events).catch((e) => console.error(`[watcher] ${ch.channel_id}:`, (e as Error).message));
      }
    } finally {
      this.running = false;
    }
    return events;
  }

  private async watch(ch: ChannelRow, events: WatchEvent[]): Promise<void> {
    const f = await this.follow(ch);
    if (f.kind !== "live") {
      if (f.kind === "settled") events.push({ channelId: ch.channel_id, action: "settled" });
      return;
    }
    const { at, stage } = f.live;
    const op = this.d.chain.operator;
    if (!op) return;
    const fresh = await getChannel(this.d.sql, ch.channel_id);
    if (!fresh || !LIVE.includes(fresh.status)) return;
    if (fresh.last_action_at && Date.now() - fresh.last_action_at.getTime() < ACTION_BACKOFF_MS) return;

    const act = async (action: "close" | "raise" | "settle", run: () => Promise<string>) => {
      await updateChannel(this.d.sql, ch.channel_id, { last_action_at: new Date() });
      const tx = await run();
      console.log(`[watcher] ${action} ${ch.channel_id} tx=${tx}`);
      events.push({ channelId: ch.channel_id, action, tx });
    };

    if (stage.kind === "open") {
      if (fresh.passes_served >= fresh.max_calls && fresh.status === "locked") {
        await updateChannel(this.d.sql, ch.channel_id, { status: "close_requested" });
        fresh.status = "close_requested";
      }
      if (fresh.status !== "close_requested") return;
      await act("close", () => op.close(at, fresh.iou_accepted, fresh.iou_signature ?? ""));
      return;
    }
    const now = await this.d.chain.nowMs();
    if (fresh.iou_accepted > stage.accepted && fresh.iou_signature) {
      if (now < stage.contestEnd - this.d.config.raiseMarginMs) {
        await act("raise", () => op.raise(at, fresh.iou_accepted, fresh.iou_signature!, stage.contestEnd));
        return;
      }
      console.warn(`[watcher] ${ch.channel_id}: IOU ${fresh.iou_accepted} beats on-chain ${stage.accepted} but the contest ends too soon to Raise`);
    }
    if (now > stage.contestEnd + 1000) await act("settle", () => op.settle(at));
  }

  /** Walks from the last known pack UTxO along the spends, recording Close / Raise / Settle as it goes. */
  private async follow(ch: ChannelRow): Promise<Followed> {
    if (!ch.utxo_tx_hash || ch.utxo_output_index === null) return { kind: "unknown" };
    const lockRef: Outref | null = ch.lock_output_index !== null ? { txHash: ch.lock_tx_hash, index: ch.lock_output_index } : null;
    let at: Outref = { txHash: ch.utxo_tx_hash, index: ch.utxo_output_index };
    let raises = [...ch.raise_tx_hashes];
    let closeTx = ch.close_tx_hash;
    let restarted = false;
    for (let hop = 0; hop < 10; hop++) {
      const outs = await this.d.chain.txOutputs(at.txHash);
      if (!outs && lockRef) {
        // Finding G4: the tx we were standing on is gone from the chain (a rollback).
        if (!sameRef(at, lockRef) && !restarted) {
          // A Close / Raise was rolled back: walk again from the lock, forgetting what we recorded after it.
          restarted = true;
          at = lockRef;
          closeTx = null;
          raises = [];
          hop = -1;
          continue;
        }
        if (sameRef(at, lockRef)) {
          // The lock itself was rolled back: stop serving calls until the pending pass sees it again.
          if (await revertChannelToPending(this.d.sql, ch.channel_id)) {
            console.warn(`[watcher] ${ch.channel_id}: lock tx ${lockRef.txHash} is gone from the chain, back to pending`);
          }
        }
        return { kind: "unknown" };
      }
      const o = outs?.find((x) => x.index === at.index);
      if (!o) return { kind: "unknown" };
      const datum = o.datumCbor ? decodePackDatum(o.datumCbor) : null;
      if (!datum || datum.channelId !== ch.channel_id) return { kind: "unknown" };
      if (!o.consumedBy) {
        const stage: Live["stage"] = datum.stage.kind === "open"
          ? { kind: "open" }
          : { kind: "closing", accepted: Number(datum.stage.accepted), contestEnd: Number(datum.stage.contestEnd) };
        if (stage.kind === "open" && ch.status === "closing") {
          // Finding G4: our record says Closing but the chain shows the pack Open again (the Close was rolled back).
          await reopenChannel(this.d.sql, ch.channel_id, at);
          console.warn(`[watcher] ${ch.channel_id}: Close rolled back, the pack is Open again at ${at.txHash}#${at.index}`);
          return { kind: "live", live: { at, stage } };
        }
        await updateChannel(this.d.sql, ch.channel_id, {
          utxo_tx_hash: at.txHash, utxo_output_index: at.index, close_tx_hash: closeTx, raise_tx_hashes: raises,
          ...(stage.kind === "closing"
            ? { status: "closing", onchain_accepted: stage.accepted, contest_end_ms: String(stage.contestEnd) }
            : {}),
        });
        return { kind: "live", live: { at, stage } };
      }
      const spender = o.consumedBy;
      const next = await this.d.chain.txOutputs(spender);
      if (!next) return { kind: "unknown" }; // the spend isn't indexed yet
      // The continuing output sits at the same script as the one it spends (not today's PACK_ESCROW address:
      // a channel locked at an older validator version must not be mistaken for settled).
      const cont = next.find((x) => x.address === o.address && x.datumCbor && safeChannel(x.datumCbor) === ch.channel_id);
      if (cont) {
        if (datum.stage.kind === "open") closeTx = spender;
        else raises.push(spender);
        at = { txHash: spender, index: cont.index };
        continue;
      }
      await this.recordSettle(ch, spender, next, closeTx, raises, datum.stage.kind === "closing" ? Number(datum.stage.accepted) : null);
      return { kind: "settled" };
    }
    return { kind: "unknown" };
  }

  private async recordSettle(ch: ChannelRow, tx: string, outs: ChainOutput[], closeTx: string | null, raises: string[], accepted: number | null) {
    const tag = tagOf(ch.channel_id);
    const paid = (addr: string) =>
      outs.filter((o) => o.address === addr && o.datumCbor === tag).reduce((a, o) => a + (o.assets[PACK_UNIT] ?? 0n), 0n);
    await updateChannel(this.d.sql, ch.channel_id, {
      status: "settled", settle_tx_hash: tx, close_tx_hash: closeTx, raise_tx_hashes: raises,
      ...(accepted !== null ? { onchain_accepted: accepted } : {}),
      seller_paid_micros: paid(ch.seller_address).toString(),
      fee_paid_micros: paid(ch.fee_address).toString(),
      buyer_refund_micros: paid(ch.refund_address).toString(),
    });
    console.log(`[watcher] ${ch.channel_id} settled in ${tx}`);
  }
}

function safeChannel(cbor: string): string | null {
  try {
    return decodePackDatum(cbor).channelId;
  } catch {
    return null;
  }
}
