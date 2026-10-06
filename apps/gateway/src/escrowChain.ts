// What the gateway needs from Cardano for escrow packs. Tests use a fake; production uses Blockfrost
// for reads and the operator wallet (OPERATOR_MNEMONIC) for Close / Raise / Settle.
import { Client, TransactionHash, TransactionInput, preprod } from "@evolution-sdk/evolution";
import { tip, txOutputs, type Blockfrost, type ChainOutput } from "@hirakumi/escrow";
import { buildClose, buildRaise, buildSettle, lockState, walletKeys, type Wallet } from "@hirakumi/escrow/txs";

export type { ChainOutput } from "@hirakumi/escrow";

export type Outref = { txHash: string; index: number };

export interface EscrowChain {
  /** All outputs of a tx (with `consumedBy` when spent); null when the chain doesn't know the tx yet. */
  txOutputs(txHash: string): Promise<ChainOutput[] | null>;
  /** POSIX ms of the chain tip. Validity intervals are judged against this, not the wall clock. */
  nowMs(): Promise<number>;
  /** Null when no operator key is configured: the watcher then only observes. */
  operator: EscrowOperator | null;
}

export interface EscrowOperator {
  close(at: Outref, accepted: number, signature: string): Promise<string>;
  raise(at: Outref, accepted: number, signature: string, contestEndMs: number): Promise<string>;
  settle(at: Outref): Promise<string>;
}

class WalletOperator implements EscrowOperator {
  private readonly w: Wallet;
  private readonly vkh: string;
  constructor(mnemonic: string, bfCfg: Blockfrost) {
    this.w = Client.make(preprod).withBlockfrost({ baseUrl: bfCfg.baseUrl, projectId: bfCfg.projectId })
      .withSeed({ mnemonic: mnemonic.trim().replace(/\s+/g, " ").toLowerCase(), accountIndex: 0 });
    this.vkh = walletKeys(mnemonic).vkh;
  }

  private async lock(at: Outref) {
    const ref = new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(at.txHash), index: BigInt(at.index) });
    const [u] = await this.w.getUtxosByOutRef([ref]);
    if (!u) throw new Error(`pack UTxO ${at.txHash}#${at.index} not found`);
    return lockState(u);
  }

  private async send(sb: { sign(): Promise<{ submit(): Promise<TransactionHash.TransactionHash> }> }): Promise<string> {
    return TransactionHash.toHex(await (await sb.sign()).submit());
  }

  async close(at: Outref, accepted: number, signature: string): Promise<string> {
    const lock = await this.lock(at);
    const b = await buildClose(this.w, {
      lock, accepted: BigInt(accepted), signature, signerVkh: this.vkh,
      validToMs: BigInt(Date.now()) + 150_000n, script: { kind: "inline" },
    });
    return this.send(b.signBuilder);
  }

  async raise(at: Outref, accepted: number, signature: string, contestEndMs: number): Promise<string> {
    const lock = await this.lock(at);
    const to = Math.min(Date.now() + 150_000, contestEndMs - 1000);
    const b = await buildRaise(this.w, { lock, accepted: BigInt(accepted), signature, validToMs: BigInt(to), script: { kind: "inline" } });
    return this.send(b.signBuilder);
  }

  async settle(at: Outref): Promise<string> {
    const lock = await this.lock(at);
    const b = await buildSettle(this.w, { lock, script: { kind: "inline" } });
    return this.send(b.signBuilder);
  }
}

export function blockfrostEscrowChain(bfCfg: Blockfrost, operatorMnemonic: string | null): EscrowChain {
  return {
    txOutputs: (h) => txOutputs(bfCfg, h),
    nowMs: async () => (await tip(bfCfg)).timeMs,
    operator: operatorMnemonic ? new WalletOperator(operatorMnemonic, bfCfg) : null,
  };
}
