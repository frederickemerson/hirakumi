// Reading pack locks from the chain (Blockfrost REST) and checking a lock
// output is exactly what the quote promised. No signing here.
import { PACK_ESCROW } from "./blueprint.js";

export type Blockfrost = { baseUrl: string; projectId: string; fetch?: typeof fetch };

/** One output as Blockfrost reports it. `assets` is keyed by unit (policy ‖ name hex), lovelace excluded. */
export type ChainOutput = {
  txHash: string;
  index: number;
  address: string;
  lovelace: bigint;
  assets: Record<string, bigint>;
  datumCbor: string | null;
  datumHash: string | null;
  referenceScriptHash: string | null;
  /** Only known for outputs read via a tx's utxos: the tx that spent it, if any. */
  consumedBy?: string | null;
};

type BfAmount = { unit: string; quantity: string };
type BfOutput = {
  tx_hash?: string;
  address: string;
  output_index: number;
  amount: BfAmount[];
  inline_datum: string | null;
  data_hash: string | null;
  reference_script_hash: string | null;
  consumed_by_tx?: string | null;
};

export class BlockfrostError extends Error {
  constructor(readonly status: number, readonly path: string, body: string) {
    super(`Blockfrost ${path}: ${status} ${body.slice(0, 300)}`);
  }
}

export async function bf<T>(cfg: Blockfrost, path: string, init?: RequestInit): Promise<T> {
  const f = cfg.fetch ?? fetch;
  const r = await f(cfg.baseUrl.replace(/\/+$/, "") + path, {
    ...init,
    headers: { project_id: cfg.projectId, ...(init?.headers as Record<string, string> | undefined) },
  });
  const text = await r.text();
  if (!r.ok) throw new BlockfrostError(r.status, path, text);
  return JSON.parse(text) as T;
}

function toOutput(txHash: string, o: BfOutput): ChainOutput {
  const assets: Record<string, bigint> = {};
  let lovelace = 0n;
  for (const a of o.amount) {
    if (a.unit === "lovelace") lovelace += BigInt(a.quantity);
    else assets[a.unit] = (assets[a.unit] ?? 0n) + BigInt(a.quantity);
  }
  return {
    txHash: o.tx_hash ?? txHash,
    index: o.output_index,
    address: o.address,
    lovelace,
    assets,
    datumCbor: o.inline_datum ?? null,
    datumHash: o.data_hash ?? null,
    referenceScriptHash: o.reference_script_hash ?? null,
    ...(o.consumed_by_tx !== undefined ? { consumedBy: o.consumed_by_tx } : {}),
  };
}

/** All outputs of a confirmed tx; null when Blockfrost doesn't know the tx (yet). */
export async function txOutputs(cfg: Blockfrost, txHash: string): Promise<ChainOutput[] | null> {
  try {
    const u = await bf<{ outputs: BfOutput[] }>(cfg, `/txs/${txHash}/utxos`);
    return u.outputs.map((o) => toOutput(txHash, o));
  } catch (e) {
    if (e instanceof BlockfrostError && e.status === 404) return null;
    throw e;
  }
}

/** Unspent outputs at an address (all pages). */
export async function addressUtxos(cfg: Blockfrost, address: string): Promise<ChainOutput[]> {
  const all: ChainOutput[] = [];
  for (let page = 1; ; page++) {
    let rows: BfOutput[];
    try {
      rows = await bf<BfOutput[]>(cfg, `/addresses/${address}/utxos?count=100&page=${page}`);
    } catch (e) {
      if (e instanceof BlockfrostError && e.status === 404) return all;
      throw e;
    }
    for (const r of rows) all.push(toOutput(r.tx_hash!, r));
    if (rows.length < 100) return all;
  }
}

export type TxSummary = { hash: string; fees: bigint; size: number; slot: number; blockTime: number; redeemers: { purpose: string; mem: bigint; steps: bigint; fee: bigint }[] };

export async function txSummary(cfg: Blockfrost, hash: string): Promise<TxSummary | null> {
  try {
    const t = await bf<{ fees: string; size: number; slot: number; block_time: number; redeemer_count: number }>(cfg, `/txs/${hash}`);
    const redeemers = t.redeemer_count
      ? (await bf<{ purpose: string; unit_mem: string; unit_steps: string; fee: string }[]>(cfg, `/txs/${hash}/redeemers`)).map((r) => ({
          purpose: r.purpose,
          mem: BigInt(r.unit_mem),
          steps: BigInt(r.unit_steps),
          fee: BigInt(r.fee),
        }))
      : [];
    return { hash, fees: BigInt(t.fees), size: t.size, slot: t.slot, blockTime: t.block_time, redeemers };
  } catch (e) {
    if (e instanceof BlockfrostError && e.status === 404) return null;
    throw e;
  }
}

export async function submitTxCbor(cfg: Blockfrost, cborHex: string): Promise<string> {
  return bf<string>(cfg, "/tx/submit", { method: "POST", headers: { "content-type": "application/cbor" }, body: Buffer.from(cborHex, "hex") });
}

/** Slot and POSIX ms of the chain tip. */
export async function tip(cfg: Blockfrost): Promise<{ slot: number; timeMs: number }> {
  const b = await bf<{ slot: number; time: number }>(cfg, "/blocks/latest");
  return { slot: b.slot, timeMs: b.time * 1000 };
}

export type LockCheck = { ok: true; output: ChainOutput } | { ok: false; reason: string };

/**
 * Finds THE lock output among a tx's outputs and checks it is safe to treat as
 * a paid pack:
 *  - exactly one output at the escrow address carries the quoted datum, byte for byte,
 *  - it holds at least `priceMicros` of the pack asset,
 *  - it holds ONLY lovelace plus the pack asset (Settle accounts for nothing else, so
 *    any other token would be stuck in the continuing output forever),
 *  - it has no reference script (the continuing output may not carry one, and
 *    Close would fail).
 */
export function checkLockOutput(
  outputs: readonly ChainOutput[],
  expected: { datumCbor: string; unit: string; priceMicros: bigint; scriptAddress?: string },
): LockCheck {
  const address = expected.scriptAddress ?? PACK_ESCROW.address;
  const datum = expected.datumCbor.toLowerCase();
  const atScript = outputs.filter((o) => o.address === address);
  if (atScript.length === 0) return { ok: false, reason: "no_output_at_escrow" };
  const ours = atScript.filter((o) => o.datumCbor?.toLowerCase() === datum);
  if (ours.length === 0) return { ok: false, reason: "datum_mismatch" };
  if (ours.length > 1) return { ok: false, reason: "duplicate_lock_outputs" };
  const o = ours[0]!;
  const units = Object.keys(o.assets).filter((u) => (o.assets[u] ?? 0n) > 0n);
  if (units.some((u) => u !== expected.unit)) return { ok: false, reason: "extra_assets" };
  if ((o.assets[expected.unit] ?? 0n) < expected.priceMicros) return { ok: false, reason: "underpaid" };
  if (o.referenceScriptHash) return { ok: false, reason: "reference_script_on_lock" };
  return { ok: true, output: o };
}
