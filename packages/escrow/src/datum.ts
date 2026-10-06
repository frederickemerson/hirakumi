// PackDatum <-> CBOR hex. Field order and shapes match
// contracts/pack-escrow/lib/hirakumi/types.ak; golden vectors pin the bytes.
import * as Data from "@evolution-sdk/evolution/Data";
import { addressFromData, addressToData, parseAddress } from "./address.js";
import { PACK_ESCROW } from "./blueprint.js";
import { hexOf, toHex } from "./hex.js";
import { isValidReceiptKey } from "./iou.js";

export type Stage = { kind: "open" } | { kind: "closing"; accepted: bigint; contestEnd: bigint /* POSIX ms */ };

/** Every on-chain Int is a bigint. Hex fields are lower-case; addresses are bech32. */
export type PackDatum = {
  channelId: string; // 32 bytes
  receiptKey: string; // 32 bytes, buyer's ed25519 IOU key
  buyerRefund: string; // its payment key hash also identifies the buyer for Close
  seller: string;
  policyId: string; // 28 bytes
  assetName: string; // 0..32 bytes
  pricePerCall: bigint; // micros
  maxCalls: bigint;
  ruleHash: string; // 32 bytes
  feeAddress: string;
  feeBps: bigint;
  closer: string; // 28 bytes, operator payment key hash
  contestPeriod: bigint; // ms
  closeFeeBudget: bigint; // lovelace
  stage: Stage;
};

const PREPROD = 0;

function stageToData(s: Stage): Data.Data {
  return s.kind === "open" ? Data.constr(0n, []) : Data.constr(1n, [Data.int(s.accepted), Data.int(s.contestEnd)]);
}

export function packDatumToData(d: PackDatum): Data.Data {
  return Data.constr(0n, [
    Data.bytearray(hexOf("channelId", d.channelId)),
    Data.bytearray(hexOf("receiptKey", d.receiptKey)),
    addressToData("buyerRefund", d.buyerRefund),
    addressToData("seller", d.seller),
    Data.bytearray(hexOf("policyId", d.policyId)),
    Data.bytearray(hexOf("assetName", d.assetName)),
    Data.int(d.pricePerCall),
    Data.int(d.maxCalls),
    Data.bytearray(hexOf("ruleHash", d.ruleHash)),
    addressToData("feeAddress", d.feeAddress),
    Data.int(d.feeBps),
    Data.bytearray(hexOf("closer", d.closer)),
    Data.int(d.contestPeriod),
    Data.int(d.closeFeeBudget),
    stageToData(d.stage),
  ]);
}

/** CBOR hex of the inline datum, byte-identical to Aiken's `cbor.serialise`. */
export function encodePackDatum(d: PackDatum): string {
  return Data.toCBORHex(packDatumToData(d));
}

function bytes(name: string, v: Data.Data | undefined): string {
  if (!(v instanceof Uint8Array)) throw new Error(`${name}: expected bytes`);
  return toHex(v);
}

function int(name: string, v: Data.Data | undefined): bigint {
  if (typeof v !== "bigint") throw new Error(`${name}: expected int`);
  return v;
}

/** Decodes an inline datum. Addresses are rebuilt for `networkId` (0 = preprod). Throws on any shape mismatch. */
export function decodePackDatum(cborHex: string, networkId = PREPROD): PackDatum {
  const d = Data.fromCBORHex(hexOf("datum", cborHex));
  if (!Data.isConstr(d) || d.index !== 0n || d.fields.length !== 15) {
    throw new Error("datum: expected Constr 0 with 15 fields");
  }
  const f = d.fields;
  const s = f[14]!;
  let stage: Stage;
  if (Data.isConstr(s) && s.index === 0n && s.fields.length === 0) stage = { kind: "open" };
  else if (Data.isConstr(s) && s.index === 1n && s.fields.length === 2) {
    stage = { kind: "closing", accepted: int("stage.accepted", s.fields[0]), contestEnd: int("stage.contestEnd", s.fields[1]) };
  } else throw new Error("stage: expected Open (Constr 0 []) or Closing (Constr 1 [accepted, contest_end])");
  return {
    channelId: bytes("channelId", f[0]),
    receiptKey: bytes("receiptKey", f[1]),
    buyerRefund: addressFromData("buyerRefund", f[2]!, networkId),
    seller: addressFromData("seller", f[3]!, networkId),
    policyId: bytes("policyId", f[4]),
    assetName: bytes("assetName", f[5]),
    pricePerCall: int("pricePerCall", f[6]),
    maxCalls: int("maxCalls", f[7]),
    ruleHash: bytes("ruleHash", f[8]),
    feeAddress: addressFromData("feeAddress", f[9]!, networkId),
    feeBps: int("feeBps", f[10]),
    closer: bytes("closer", f[11]),
    contestPeriod: int("contestPeriod", f[12]),
    closeFeeBudget: int("closeFeeBudget", f[13]),
    stage,
  };
}

export const MIN_CONTEST_PERIOD_MS = 60_000n;
export const MAX_CONTEST_PERIOD_MS = 30n * 86_400_000n;
export const MAX_FEE_BPS = 1000n;
/** Below this a Settle can't pay its own network fee, and the pack would be stuck. */
export const MIN_CLOSE_FEE_BUDGET = 500_000n;
/** Caps what the buyer can be charged for the Settle fee. */
export const MAX_CLOSE_FEE_BUDGET = 2_000_000n;
/** Mirrors the validator's `max_close_window`: a Close tx's validity range may span at most this. */
export const MAX_CLOSE_WINDOW_MS = 3_600_000n;

function payoutAddress(name: string, bech32: string): void {
  const a = parseAddress(name, bech32);
  if (a.networkId !== PREPROD) throw new Error(`${name} must be a preprod address`);
  if (bech32 === PACK_ESCROW.address || a.payment.hash === PACK_ESCROW.scriptHash) {
    throw new Error(`${name} must not be the escrow address`);
  }
  if (a.payment.kind !== "key") throw new Error(`${name} must have a verification-key payment credential`);
}

/**
 * Throws unless `d` is safe to lock: the validator doesn't check datum sanity
 * at lock time, so this is the only guard against funds that can never pay
 * out as intended. Equal seller / refund / fee addresses are allowed.
 *
 * `lock.priceMicros` is the pack price; it must equal pricePerCall × maxCalls.
 */
export function validateDatumForLock(d: PackDatum, lock: { priceMicros: bigint }): void {
  hexOf("channelId", d.channelId, 32);
  hexOf("receiptKey", d.receiptKey, 32);
  if (!isValidReceiptKey(d.receiptKey)) throw new Error("receiptKey is not a usable ed25519 key");
  hexOf("ruleHash", d.ruleHash, 32);
  hexOf("closer", d.closer, 28);
  hexOf("policyId", d.policyId, 28);
  if (hexOf("assetName", d.assetName).length > 64) throw new Error("assetName must be at most 32 bytes");
  payoutAddress("buyerRefund", d.buyerRefund);
  payoutAddress("seller", d.seller);
  payoutAddress("feeAddress", d.feeAddress);

  if (d.maxCalls < 1n) throw new Error("maxCalls must be at least 1");
  if (lock.priceMicros <= 0n) throw new Error("priceMicros must be positive");
  if (lock.priceMicros % d.maxCalls !== 0n) throw new Error("priceMicros must divide exactly by maxCalls");
  if (d.pricePerCall !== lock.priceMicros / d.maxCalls) throw new Error("pricePerCall must equal priceMicros / maxCalls");

  if (d.feeBps < 0n || d.feeBps > MAX_FEE_BPS) throw new Error("feeBps must be within 0…1000");
  if (d.contestPeriod < MIN_CONTEST_PERIOD_MS || d.contestPeriod > MAX_CONTEST_PERIOD_MS) {
    throw new Error("contestPeriod must be within 60 000 ms…30 days");
  }
  if (d.closeFeeBudget < MIN_CLOSE_FEE_BUDGET || d.closeFeeBudget > MAX_CLOSE_FEE_BUDGET) {
    throw new Error(`closeFeeBudget must be within ${MIN_CLOSE_FEE_BUDGET}…${MAX_CLOSE_FEE_BUDGET} lovelace`);
  }
  if (d.stage.kind !== "open") throw new Error("a new lock must be Open");

  // The exact bytes we publish must decode back to the same datum.
  const again = decodePackDatum(encodePackDatum(d));
  if (encodePackDatum(again) !== encodePackDatum(d)) throw new Error("datum does not round-trip");
}
