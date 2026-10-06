import { Address, Assets, InlineDatum, TransactionHash, UTxO } from "@evolution-sdk/evolution";
import { describe, expect, it } from "vitest";
import { MAX_CLOSE_WINDOW_MS, PACK_ESCROW, packDatumToData, settleObligations, type PackDatum } from "../src/index.js";
import { alignMs, buildSettle, closeValidity, lockState, type Wallet } from "../src/txs.js";
import { BUYER, FEE, SELLER, goldenDatum } from "./golden.js";

const FOREIGN = "f0".repeat(28) + "6e6674";
const closing = (accepted: bigint): PackDatum => ({ ...goldenDatum(), stage: { kind: "closing", accepted, contestEnd: 0n } });

function lockUtxo(d: PackDatum, assets: Assets.Assets): UTxO.UTxO {
  return new UTxO.UTxO({
    transactionId: TransactionHash.fromHex("aa".repeat(32)),
    index: 0n,
    address: Address.fromBech32(PACK_ESCROW.address),
    assets,
    datumOption: new InlineDatum.InlineDatum({ data: packDatumToData(d) }),
  });
}

describe("lockState", () => {
  it("separates lovelace, the pack token and foreign assets", () => {
    const d = closing(62n);
    const assets = Assets.merge(
      Assets.fromHexStrings(d.policyId, d.assetName, 2_000_000n, 2_000_000n),
      Assets.fromRecord({ lovelace: 0n, [FOREIGN]: 5n }),
    );
    const s = lockState(lockUtxo(d, assets));
    expect(s.lovelace).toBe(2_000_000n);
    expect(s.tokens).toBe(2_000_000n);
    expect(s.other).toEqual({ [FOREIGN]: 5n });
  });

  it("other is empty for a plain lock", () => {
    const d = closing(0n);
    expect(lockState(lockUtxo(d, Assets.fromHexStrings(d.policyId, d.assetName, 1n, 2_000_000n))).other).toEqual({});
  });
});

describe("settleObligations with a lock's foreign assets", () => {
  it("pays foreign assets to the buyer alongside the buyer's share", () => {
    const d = closing(62n);
    expect(settleObligations(d, { tokens: 2_000_000n, lovelace: 2_000_000n }, 400_000n, { other: { [FOREIGN]: 5n } })).toEqual([
      { address: SELLER, tokens: 1_202_800n, lovelace: 0n },
      { address: FEE, tokens: 37_200n, lovelace: 0n },
      { address: BUYER, tokens: 760_000n, lovelace: 1_600_000n, other: { [FOREIGN]: 5n } },
    ]);
  });

  it("keeps the buyer entry when all calls were accepted and only foreign assets are owed", () => {
    const d = closing(100n);
    const out = settleObligations(d, { tokens: 2_000_000n, lovelace: 400_000n }, 400_000n, { other: { [FOREIGN]: 1n } });
    expect(out.find((o) => o.address === BUYER)).toEqual({ address: BUYER, tokens: 0n, lovelace: 0n, other: { [FOREIGN]: 1n } });
  });
});

describe("closeValidity (mirrors max_close_window / min_contest_period)", () => {
  const now = alignMs(1_760_000_000_000n);

  it("aligns both bounds and adds the contest period to the upper bound", () => {
    expect(closeValidity(now - 60_000n, now + 600_000n, 180_000n)).toEqual({
      from: now - 60_000n,
      to: now + 600_000n,
      contestEnd: now + 780_000n,
    });
  });

  it("accepts a window of exactly MAX_CLOSE_WINDOW_MS and rejects a longer one", () => {
    expect(closeValidity(now, now + MAX_CLOSE_WINDOW_MS, 60_000n).to).toBe(now + MAX_CLOSE_WINDOW_MS);
    expect(() => closeValidity(now, now + MAX_CLOSE_WINDOW_MS + 1_000n, 60_000n)).toThrow(/exceeds/);
    expect(() => closeValidity(now, now + 365n * 86_400_000n, 60_000n)).toThrow(/exceeds/);
  });

  it("rejects an empty window", () => {
    expect(() => closeValidity(now, now, 60_000n)).toThrow(/empty/);
    expect(() => closeValidity(now + 1_000n, now, 60_000n)).toThrow(/empty/);
  });

  it("clamps a short or negative contest period to 60 s", () => {
    expect(closeValidity(now, now + 1_000n, -1_000_000n).contestEnd).toBe(now + 1_000n + 60_000n);
    expect(closeValidity(now, now + 1_000n, 59_999n).contestEnd).toBe(now + 1_000n + 60_000n);
  });
});

describe("buildSettle signer", () => {
  it("refuses a signer that is neither the closer nor the buyer (the buyer would not owe the fee)", async () => {
    const d = closing(62n);
    const lock = lockState(lockUtxo(d, Assets.fromHexStrings(d.policyId, d.assetName, 2_000_000n, 2_000_000n)));
    await expect(buildSettle({} as Wallet, { lock, script: { kind: "inline" }, signerVkh: "33".repeat(28) })).rejects.toThrow(
      /closer or the buyer/,
    );
    await expect(buildSettle({} as Wallet, { lock, script: { kind: "inline" }, signerVkh: "33" })).rejects.toThrow(/signerVkh/);
  });
});
