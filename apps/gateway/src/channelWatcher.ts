// ChannelWatcher: follows every escrow pack on-chain and acts for the seller.
//  - pending channels: verify the lock (datum bytes, address, price, nothing but lovelace + the pack asset)
//  - follows each pack UTxO through Close / Raise / Settle, whoever submitted them
//  - Open and (buyer asked to close, or every call served) → Close with the latest IOU
//  - Closing with an older count than our latest IOU → Raise, while ≥ raiseMargin of the contest is left
//  - after contest_end → Settle
// Without an operator key it only verifies and observes.
import { listChannels, updateChannel, type ChannelRow, type Sql } from "@hirakumi/db";
import { PACK_ESCROW, decodePackDatum, type ChainOutput } from "@hirakumi/escrow";
import type { PackEscrowConfig } from "./config";
import type { EscrowChain, Outref } from "./escrowChain";
import { PACK_UNIT, verifyChannelLock } from "./escrowPacks";

const ACTION_BACKOFF_MS = 90_000;
const tagOf = (channelId: string) => `5820${channelId}`;

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
      for (const ch of await listChannels(this.d.sql, ["pending"])) {
        const v = await verifyChannelLock(this.d.sql, this.d.chain, ch).catch(() => "unseen" as const);
        if (v === "locked") events.push({ channelId: ch.channel_id, action: "verified" });
        if (v === "refused") events.push({ channelId: ch.channel_id, action: "refused" });
      }
      for (const ch of await listChannels(this.d.sql, ["locked", "close_requested", "closing"])) {
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
    const fresh = (await listChannels(this.d.sql, ["locked", "close_requested", "closing"])).find((c) => c.channel_id === ch.channel_id);
    if (!fresh) return;
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
    let at: Outref = { txHash: ch.utxo_tx_hash, index: ch.utxo_output_index };
    const raises = [...ch.raise_tx_hashes];
    let closeTx = ch.close_tx_hash;
    for (let hop = 0; hop < 10; hop++) {
      const outs = await this.d.chain.txOutputs(at.txHash);
      const o = outs?.find((x) => x.index === at.index);
      if (!o) return { kind: "unknown" };
      const datum = o.datumCbor ? decodePackDatum(o.datumCbor) : null;
      if (!datum || datum.channelId !== ch.channel_id) return { kind: "unknown" };
      if (!o.consumedBy) {
        const stage: Live["stage"] = datum.stage.kind === "open"
          ? { kind: "open" }
          : { kind: "closing", accepted: Number(datum.stage.accepted), contestEnd: Number(datum.stage.contestEnd) };
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
      const cont = next.find((x) => x.address === PACK_ESCROW.address && x.datumCbor && safeChannel(x.datumCbor) === ch.channel_id);
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
