// An in-memory chain for escrow tests: txs with outputs, spends that mark `consumedBy`, and an operator
// whose Close / Raise / Settle follow the validator's state transitions.
import { createHash } from "node:crypto";
import { PACK_ESCROW, decodePackDatum, encodePackDatum, settleObligations, type ChainOutput, type PackDatum } from "@hirakumi/escrow";
import type { EscrowChain, EscrowOperator, Outref } from "../src/escrowChain";
import { PACK_UNIT } from "../src/escrowPacks";

let n = 0;
const newHash = () => createHash("sha256").update(`fake-tx-${n++}-${Math.random()}`).digest("hex");

export class FakeEscrowChain implements EscrowChain {
  txs = new Map<string, ChainOutput[]>();
  now = Date.now();
  actions: { kind: "close" | "raise" | "settle"; at: Outref; accepted?: number; tx: string }[] = [];
  operator: EscrowOperator | null;

  constructor(withOperator = true) {
    this.operator = withOperator ? this.makeOperator() : null;
  }

  async txOutputs(h: string) { return this.txs.get(h)?.map((o) => ({ ...o, assets: { ...o.assets } })) ?? null; }
  async nowMs() { return this.now; }

  /** A lock tx as x402 would land it: one output at the escrow (plus a change output). */
  putLock(txHash: string, datumCbor: string, opts: { tokens?: bigint; extraAssets?: Record<string, bigint>; address?: string } = {}) {
    this.txs.set(txHash, [
      { txHash, index: 0, address: "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y", lovelace: 5_000_000n, assets: {}, datumCbor: null, datumHash: null, referenceScriptHash: null, consumedBy: null },
      {
        txHash, index: 1, address: opts.address ?? PACK_ESCROW.address, lovelace: 2_982_520n,
        assets: { [PACK_UNIT]: opts.tokens ?? 2_000_000n, ...(opts.extraAssets ?? {}) },
        datumCbor, datumHash: null, referenceScriptHash: null, consumedBy: null,
      },
    ]);
  }

  output(at: Outref): ChainOutput {
    const o = this.txs.get(at.txHash)?.find((x) => x.index === at.index);
    if (!o) throw new Error(`no output ${at.txHash}#${at.index}`);
    return o;
  }

  /** Spends `at` into a new tx whose only output continues the pack with `next` (or pays out when null). */
  spend(at: Outref, next: PackDatum | null, payouts: ChainOutput[] = []): string {
    const o = this.output(at);
    if (o.consumedBy) throw new Error("already spent");
    const h = newHash();
    o.consumedBy = h;
    const outs: ChainOutput[] = next
      ? [{ ...o, txHash: h, index: 0, datumCbor: encodePackDatum(next), consumedBy: null }]
      : payouts.map((p, i) => ({ ...p, txHash: h, index: i }));
    this.txs.set(h, outs);
    return h;
  }

  private makeOperator(): EscrowOperator {
    return {
      close: async (at, accepted) => {
        const d = decodePackDatum(this.output(at).datumCbor!);
        const tx = this.spend(at, { ...d, stage: { kind: "closing", accepted: BigInt(accepted), contestEnd: BigInt(this.now) + d.contestPeriod } });
        this.actions.push({ kind: "close", at, accepted, tx });
        return tx;
      },
      raise: async (at, accepted) => {
        const d = decodePackDatum(this.output(at).datumCbor!);
        if (d.stage.kind !== "closing" || this.now >= Number(d.stage.contestEnd)) throw new Error("raise after contest_end");
        const tx = this.spend(at, { ...d, stage: { kind: "closing", accepted: BigInt(accepted), contestEnd: d.stage.contestEnd } });
        this.actions.push({ kind: "raise", at, accepted, tx });
        return tx;
      },
      settle: async (at) => {
        const o = this.output(at);
        const d = decodePackDatum(o.datumCbor!);
        if (d.stage.kind !== "closing" || this.now <= Number(d.stage.contestEnd)) throw new Error("settle before contest_end");
        const tag = `5820${d.channelId}`;
        const outs = settleObligations(d, { tokens: o.assets[PACK_UNIT] ?? 0n, lovelace: o.lovelace }, 300_000n).map((p) => ({
          txHash: "", index: 0, address: p.address, lovelace: p.lovelace > 0n ? p.lovelace : 1_300_000n,
          assets: p.tokens > 0n ? { [PACK_UNIT]: p.tokens } : {}, datumCbor: tag, datumHash: null, referenceScriptHash: null, consumedBy: null,
        }));
        const tx = this.spend(at, null, outs);
        this.actions.push({ kind: "settle", at, tx });
        return tx;
      },
    };
  }

  /** Someone else closes with an old IOU (e.g. the buyer with 0). */
  closeAs(at: Outref, accepted: number): string {
    const d = decodePackDatum(this.output(at).datumCbor!);
    return this.spend(at, { ...d, stage: { kind: "closing", accepted: BigInt(accepted), contestEnd: BigInt(this.now) + d.contestPeriod } });
  }
}
