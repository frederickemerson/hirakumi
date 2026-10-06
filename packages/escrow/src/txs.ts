// Close / Raise / Settle (and reference-script deploy) transactions for the
// pack_escrow validator, built with the Evolution SDK that ships with
// @x402/cardano. The submitter's wallet funds fees, collateral and any min-ADA
// top-up. Settle's network fee comes out of the locked lovelace, which the
// validator allows only for a Settle signed by the closer or the buyer; so
// buildSettle always adds such a required signer.
import {
  Address,
  Assets,
  Data,
  InlineDatum,
  KeyHash,
  PlutusV3,
  Redeemer as RedeemerMod,
  ScriptHash,
  Time,
  TransactionHash,
  TxOut,
  preprod,
  type Client,
  type UTxO,
} from "@evolution-sdk/evolution";
import type { BuildOptions, Evaluator } from "@evolution-sdk/evolution/sdk/builders/TransactionBuilder";
import { Effect } from "effect";
import { addressFromSeed } from "@evolution-sdk/evolution/sdk/wallet/Derivation";
import { PACK_ESCROW } from "./blueprint.js";
import { parseAddress } from "./address.js";
import { MAX_CLOSE_WINDOW_MS, MIN_CONTEST_PERIOD_MS, decodePackDatum, packDatumToData, type PackDatum } from "./datum.js";
import { hexOf } from "./hex.js";
import { verifyReceipt } from "./iou.js";
import { settleObligations } from "./payouts.js";

export type Wallet = Client.SigningClient;

export const escrowScript = new PlutusV3.PlutusV3({ bytes: Uint8Array.from(Buffer.from(PACK_ESCROW.scriptCbor, "hex")) });
{
  const h = ScriptHash.toHex(ScriptHash.fromScript(escrowScript));
  if (h !== PACK_ESCROW.scriptHash) throw new Error(`escrow script hash ${h} != blueprint ${PACK_ESCROW.scriptHash}`);
}

/** Where spends get the validator from: inline in the witness set, or a reference input. */
export type ScriptSource = { kind: "inline" } | { kind: "reference"; utxo: UTxO.UTxO };

export const Redeemer = {
  close: (accepted: bigint, signature: string) => Data.constr(0n, [Data.int(accepted), Data.bytearray(hexOf("signature", signature))]),
  raise: (accepted: bigint, signature: string) => Data.constr(1n, [Data.int(accepted), Data.bytearray(hexOf("signature", signature))]),
  settle: () => Data.constr(2n, []),
};

export const msOfSlot = (slot: bigint) => Time.slotToUnixTime(slot, preprod.slotConfig);
export const slotOfMs = (ms: bigint) => Time.unixTimeToSlot(ms, preprod.slotConfig);
/** Rounds down to a slot boundary, so the time the script sees is exactly this value. */
export const alignMs = (ms: bigint) => msOfSlot(slotOfMs(ms));

const COINS_PER_UTXO_BYTE = 4310n;
// The ledger needs ≥ 150% of the fee; every fee here is ≤ close_fee_budget (0.7 ADA), so 1.05 ADA always
// suffices. Asking for more makes lean wallets fail with a collateral return below min-UTxO.
const COLLATERAL = 1_050_000n;

/**
 * `other`: every asset in the lock besides lovelace and the pack token, by unit
 * (policy id hex ‖ asset name hex). Settle must return them to the buyer.
 */
export type LockState = { utxo: UTxO.UTxO; datum: PackDatum; lovelace: bigint; tokens: bigint; other: Record<string, bigint> };

/** Decodes a pack UTxO read from the chain. Throws when it isn't one. */
export function lockState(utxo: UTxO.UTxO): LockState {
  if (Address.toBech32(utxo.address) !== PACK_ESCROW.address) throw new Error("not at the escrow address");
  const d = utxo.datumOption;
  if (!d || !InlineDatum.isInlineDatum(d)) throw new Error("lock has no inline datum");
  const datum = decodePackDatum(Data.toCBORHex(d.data));
  const pack = datum.policyId + datum.assetName;
  const other: Record<string, bigint> = {};
  for (const unit of Assets.getUnits(utxo.assets)) {
    if (unit === "lovelace" || unit === pack) continue;
    const q = Assets.getByUnit(utxo.assets, unit);
    if (q > 0n) other[unit] = q;
  }
  return { utxo, datum, lovelace: Assets.lovelaceOf(utxo.assets), tokens: Assets.getByUnit(utxo.assets, pack), other };
}

const packAssets = (d: PackDatum, tokens: bigint, lovelace: bigint, other?: Record<string, bigint>) => {
  const base = tokens > 0n ? Assets.fromHexStrings(d.policyId, d.assetName, tokens, lovelace) : Assets.fromLovelace(lovelace);
  return other && Object.keys(other).length > 0 ? Assets.merge(base, Assets.fromRecord({ ...other, lovelace: 0n })) : base;
};

/**
 * Validity range and contest end of a Close, exactly as the validator sees them:
 * both bounds slot-aligned, `to − from ≤ MAX_CLOSE_WINDOW_MS` (on-chain
 * `max_close_window`), and contest_end = to + max(contestPeriod, MIN_CONTEST_PERIOD_MS)
 * (on-chain `min_contest_period`). Throws on an empty or over-long window.
 */
export function closeValidity(validFromMs: bigint, validToMs: bigint, contestPeriod: bigint): { from: bigint; to: bigint; contestEnd: bigint } {
  const from = alignMs(validFromMs);
  const to = alignMs(validToMs);
  if (from >= to) throw new Error("Close validity range is empty (validFrom must be before validTo)");
  if (to - from > MAX_CLOSE_WINDOW_MS) throw new Error(`Close validity range exceeds ${MAX_CLOSE_WINDOW_MS} ms`);
  const period = contestPeriod > MIN_CONTEST_PERIOD_MS ? contestPeriod : MIN_CONTEST_PERIOD_MS;
  return { from, to, contestEnd: to + period };
}

const inline = (data: Data.Data) => new InlineDatum.InlineDatum({ data });

/** Lovelace the continuing output needs: at least what it had, and at least min-UTxO for the (bigger) next datum. */
export function continuingLovelace(next: PackDatum, tokens: bigint, lovelaceIn: bigint, other?: Record<string, bigint>): bigint {
  const out = new TxOut.TransactionOutput({
    address: Address.fromBech32(PACK_ESCROW.address),
    assets: packAssets(next, tokens, lovelaceIn > 5_000_000n ? lovelaceIn : 5_000_000n, other),
    datumOption: inline(packDatumToData(next)),
  });
  const min = BigInt(160 + TxOut.toCBORBytes(out).length) * COINS_PER_UTXO_BYTE;
  return min > lovelaceIn ? min : lovelaceIn;
}

function withScript<T extends { attachScript(p: { script: PlutusV3.PlutusV3 }): T; readFrom(p: { referenceInputs: ReadonlyArray<UTxO.UTxO> }): T }>(
  tx: T,
  s: ScriptSource,
): T {
  return s.kind === "inline" ? tx.attachScript({ script: escrowScript }) : tx.readFrom({ referenceInputs: [s.utxo] });
}

async function walletUtxos(w: Wallet, exclude: ScriptSource): Promise<UTxO.UTxO[]> {
  const all = await w.getWalletUtxos();
  // Never spend the reference-script UTxO as a fee input.
  return all.filter((u) => !u.scriptRef && !(exclude.kind === "reference" && TransactionHash.toHex(u.transactionId) === TransactionHash.toHex(exclude.utxo.transactionId) && u.index === exclude.utxo.index));
}

export type Built = { signBuilder: Awaited<ReturnType<ReturnType<Wallet["newTx"]>["build"]>>; fee: bigint; next?: PackDatum };

async function feeOf(sb: Built["signBuilder"]): Promise<bigint> {
  return (await sb.toTransaction()).body.fee;
}

/**
 * Open → Closing{accepted, contest_end = validTo + max(contest_period, 60 s)}.
 * `signerVkh` must be the closer or the buyer's payment key hash, and the wallet must hold that key.
 * accepted = 0 needs no IOU (signature ignored).
 * The validity range [validFromMs, validToMs] may span at most MAX_CLOSE_WINDOW_MS (1 h);
 * validFromMs defaults to one minute ago.
 */
export async function buildClose(
  w: Wallet,
  p: {
    lock: LockState;
    accepted: bigint;
    signature?: string;
    signerVkh: string;
    validToMs: bigint;
    validFromMs?: bigint;
    script: ScriptSource;
    build?: BuildOptions;
  },
): Promise<Built> {
  const { datum, tokens, lovelace } = p.lock;
  if (datum.stage.kind !== "open") throw new Error("pack is not Open");
  if (p.accepted < 0n || p.accepted > datum.maxCalls) throw new Error("accepted out of range");
  const sig = p.accepted === 0n ? "" : (p.signature ?? "");
  if (p.accepted > 0n && !verifyReceipt(datum.receiptKey, datum.channelId, p.accepted, sig)) throw new Error("IOU does not verify");
  const { from, to, contestEnd } = closeValidity(p.validFromMs ?? BigInt(Date.now()) - 60_000n, p.validToMs, datum.contestPeriod);
  const next: PackDatum = { ...datum, stage: { kind: "closing", accepted: p.accepted, contestEnd } };
  const lov = continuingLovelace(next, tokens, lovelace, p.lock.other);
  const sb = await withScript(w.newTx(), p.script)
    .collectFrom({ inputs: [p.lock.utxo], redeemer: Redeemer.close(p.accepted, sig) })
    .payToAddress({ address: Address.fromBech32(PACK_ESCROW.address), assets: packAssets(datum, tokens, lov, p.lock.other), datum: inline(packDatumToData(next)) })
    .addSigner({ keyHash: KeyHash.fromHex(p.signerVkh) })
    .setValidity({ from, to })
    .build({ changeAddress: await w.address(), availableUtxos: await walletUtxos(w, p.script), setCollateral: COLLATERAL, ...p.build });
  return { signBuilder: sb, fee: await feeOf(sb), next };
}

/** Closing{a} → Closing{accepted > a}, same contest_end. Anyone may submit; must land before contest_end. */
export async function buildRaise(
  w: Wallet,
  p: { lock: LockState; accepted: bigint; signature: string; validToMs: bigint; script: ScriptSource; build?: BuildOptions },
): Promise<Built> {
  const { datum, tokens, lovelace } = p.lock;
  if (datum.stage.kind !== "closing") throw new Error("pack is not Closing");
  if (p.accepted <= datum.stage.accepted) throw new Error("Raise must increase accepted");
  if (p.accepted > datum.maxCalls || p.accepted * datum.pricePerCall > tokens) throw new Error("accepted out of range");
  if (!verifyReceipt(datum.receiptKey, datum.channelId, p.accepted, p.signature)) throw new Error("IOU does not verify");
  const end = datum.stage.contestEnd;
  let to = alignMs(p.validToMs);
  if (to > end - 1000n) to = alignMs(end - 1000n);
  const next: PackDatum = { ...datum, stage: { kind: "closing", accepted: p.accepted, contestEnd: end } };
  const lov = continuingLovelace(next, tokens, lovelace, p.lock.other);
  const sb = await withScript(w.newTx(), p.script)
    .collectFrom({ inputs: [p.lock.utxo], redeemer: Redeemer.raise(p.accepted, p.signature) })
    .payToAddress({ address: Address.fromBech32(PACK_ESCROW.address), assets: packAssets(datum, tokens, lov, p.lock.other), datum: inline(packDatumToData(next)) })
    .setValidity({ to })
    .build({ changeAddress: await w.address(), availableUtxos: await walletUtxos(w, p.script), setCollateral: COLLATERAL, ...p.build });
  return { signBuilder: sb, fee: await feeOf(sb), next };
}

/** First slot-aligned time strictly after contest_end: the earliest valid Settle lower bound. */
export function settleFromMs(contestEnd: bigint): bigint {
  const a = alignMs(contestEnd);
  return a > contestEnd ? a : a + 1000n;
}

/**
 * Closing → paid out. Outputs follow `settleObligations` (per-address, tagged with
 * channel_id); any foreign assets in the lock go to the buyer.
 *
 * The tx is signed by `signerVkh`, which must be the datum's closer or the buyer's
 * payment key hash (the wallet must hold that key). Only such a Settle may charge
 * the buyer the network fee; an unsigned one must give the buyer all the locked
 * lovelace. Here the buyer's lovelace is `locked − tx.fee`, which is circular:
 *  1. Build once with the buyer getting ALL the locked lovelace. That passes the
 *     validator whatever the draft fee is, so normal evaluation yields the real ex-units.
 *  2. Rebuild with those ex-units fixed (+5%) and buyer = locked − fee until the fee
 *     is stable. (Evaluating these drafts would fail: the builder's draft tx carries
 *     a provisional fee, and the script reads tx.fee.)
 * Callers should evaluate the final tx (e.g. Blockfrost /utils/txs/evaluate) before submitting.
 */
export async function buildSettle(
  w: Wallet,
  p: { lock: LockState; script: ScriptSource; signerVkh: string; fromMs?: bigint; build?: BuildOptions },
): Promise<Built & { payouts: ReturnType<typeof settleObligations>; exUnits: { mem: bigint; steps: bigint } }> {
  const { datum, tokens, lovelace, other } = p.lock;
  if (datum.stage.kind !== "closing") throw new Error("pack is not Closing");
  const signer = hexOf("signerVkh", p.signerVkh, 28);
  const buyerPay = parseAddress("buyerRefund", datum.buyerRefund).payment;
  if (signer !== datum.closer && !(buyerPay.kind === "key" && buyerPay.hash === signer)) {
    throw new Error("signerVkh must be the datum's closer or the buyer's payment key hash");
  }
  const from = p.fromMs ?? settleFromMs(datum.stage.contestEnd);
  const tag = inline(Data.bytearray(datum.channelId));
  const avail = await walletUtxos(w, p.script);
  const change = await w.address();
  const lockRef = `${TransactionHash.toHex(p.lock.utxo.transactionId)}#${p.lock.utxo.index}`;

  const once = (assumedFee: bigint, extra?: Partial<BuildOptions>) => {
    const payouts = settleObligations(datum, { tokens, lovelace }, assumedFee, { chargeFee: true, other });
    let tx = withScript(w.newTx(), p.script).collectFrom({ inputs: [p.lock.utxo], redeemer: Redeemer.settle() });
    for (const o of payouts) {
      tx = tx.payToAddress({ address: Address.fromBech32(o.address), assets: packAssets(datum, o.tokens, o.lovelace, o.other), datum: tag, autoMinUtxo: true });
    }
    return { payouts, sb: tx.addSigner({ keyHash: KeyHash.fromHex(signer) }).setValidity({ from }).build({ changeAddress: change, availableUtxos: avail, setCollateral: COLLATERAL, ...p.build, ...extra }) };
  };

  const first = await once(0n).sb;
  const measured = (await first.toTransaction()).witnessSet.redeemers?.toArray()[0]?.exUnits;
  if (!measured) throw new Error("Settle draft has no redeemer");
  const exUnits = { mem: (measured.mem * 105n) / 100n, steps: (measured.steps * 105n) / 100n };
  const evaluator: Evaluator = {
    evaluate: (tx) =>
      Effect.succeed([
        {
          ex_units: new RedeemerMod.ExUnits(exUnits),
          redeemer_index: tx.body.inputs.findIndex((i) => `${TransactionHash.toHex(i.transactionId)}#${i.index}` === lockRef),
          redeemer_tag: "spend" as const,
        },
      ]),
  };

  let assumed = await feeOf(first);
  for (let i = 0; i < 5; i++) {
    const { payouts, sb: pending } = once(assumed, { evaluator });
    const sb = await pending;
    const fee = await feeOf(sb);
    if (fee >= assumed) {
      if (fee > datum.closeFeeBudget) throw new Error(`Settle fee ${fee} exceeds close_fee_budget ${datum.closeFeeBudget}`);
      return { signBuilder: sb, fee, payouts, exUnits };
    }
    assumed = fee;
  }
  throw new Error("Settle fee did not converge");
}

/** Parks the validator as a reference script at `holder` (an address we control that no fee wallet spends from). */
export async function buildDeployReference(w: Wallet, holder: string): Promise<Built> {
  const p: { build?: BuildOptions } = {};
  const sb = await w
    .newTx()
    .payToAddress({ address: Address.fromBech32(holder), assets: Assets.fromLovelace(0n), script: escrowScript, autoMinUtxo: true })
    .build({ changeAddress: await w.address(), setCollateral: COLLATERAL, ...p.build });
  return { signBuilder: sb, fee: await feeOf(sb) };
}

/** Base address (account 0) and payment key hash of a mnemonic: the same derivation the x402 signer uses. */
export function walletKeys(mnemonic: string, accountIndex = 0): { address: string; vkh: string } {
  const { address } = addressFromSeed(mnemonic.trim().replace(/\s+/g, " ").toLowerCase(), { accountIndex, networkId: 0 });
  const pc = address.paymentCredential;
  if (!(pc instanceof KeyHash.KeyHash)) throw new Error("expected a key payment credential");
  return { address: Address.toBech32(address), vkh: KeyHash.toHex(pc) };
}
