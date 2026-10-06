import { describe, expect, it } from "vitest";
import { PACK_ESCROW, checkLockOutput, txOutputs, type ChainOutput } from "../src/index.js";
import { Redeemer, alignMs, continuingLovelace, settleFromMs } from "../src/txs.js";
import { GOLDEN_OPEN_CBOR, USDM_NAME, USDM_POLICY, goldenDatum, SELLER } from "./golden.js";
import * as Data from "@evolution-sdk/evolution/Data";

const UNIT = USDM_POLICY + USDM_NAME;
const out = (o: Partial<ChainOutput> = {}): ChainOutput => ({
  txHash: "aa".repeat(32),
  index: 0,
  address: PACK_ESCROW.address,
  lovelace: 2_982_520n,
  assets: { [UNIT]: 2_000_000n },
  datumCbor: GOLDEN_OPEN_CBOR,
  datumHash: null,
  referenceScriptHash: null,
  ...o,
});
const expected = { datumCbor: GOLDEN_OPEN_CBOR, unit: UNIT, priceMicros: 2_000_000n };

describe("checkLockOutput", () => {
  it("accepts the quoted datum at the escrow with the price in the pack asset", () => {
    const r = checkLockOutput([out({ address: SELLER, datumCbor: null, index: 1 }), out()], expected);
    expect(r).toMatchObject({ ok: true, output: { index: 0 } });
  });

  it("refuses a lock that carries any other asset", () => {
    const r = checkLockOutput([out({ assets: { [UNIT]: 2_000_000n, ["ff".repeat(28) + "01"]: 1n } })], expected);
    expect(r).toEqual({ ok: false, reason: "extra_assets" });
  });

  it("refuses a different datum, a wrong address, underpayment, duplicates and reference scripts", () => {
    expect(checkLockOutput([out({ datumCbor: GOLDEN_OPEN_CBOR.replace(/ff$/, "fe") })], expected)).toEqual({ ok: false, reason: "datum_mismatch" });
    expect(checkLockOutput([out({ address: SELLER })], expected)).toEqual({ ok: false, reason: "no_output_at_escrow" });
    expect(checkLockOutput([out({ assets: { [UNIT]: 1_999_999n } })], expected)).toEqual({ ok: false, reason: "underpaid" });
    expect(checkLockOutput([out(), out({ index: 1 })], expected)).toEqual({ ok: false, reason: "duplicate_lock_outputs" });
    expect(checkLockOutput([out({ referenceScriptHash: "11".repeat(28) })], expected)).toEqual({ ok: false, reason: "reference_script_on_lock" });
  });

  it("compares datum hex case-insensitively", () => {
    expect(checkLockOutput([out({ datumCbor: GOLDEN_OPEN_CBOR.toUpperCase() })], expected).ok).toBe(true);
  });
});

describe("txOutputs (Blockfrost shape)", () => {
  it("parses amounts, inline datum and spentness; 404 → null", async () => {
    const fake = (async (url: string) => {
      if (url.includes("missing")) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({
          outputs: [
            {
              address: PACK_ESCROW.address,
              output_index: 0,
              amount: [
                { unit: "lovelace", quantity: "2982520" },
                { unit: UNIT, quantity: "2000000" },
              ],
              inline_datum: GOLDEN_OPEN_CBOR,
              data_hash: "x",
              reference_script_hash: null,
              consumed_by_tx: "bb".repeat(32),
            },
          ],
        }),
      );
    }) as typeof fetch;
    const cfg = { baseUrl: "https://bf.invalid", projectId: "p", fetch: fake };
    const outs = await txOutputs(cfg, "aa".repeat(32));
    expect(outs![0]).toMatchObject({ lovelace: 2_982_520n, assets: { [UNIT]: 2_000_000n }, datumCbor: GOLDEN_OPEN_CBOR, consumedBy: "bb".repeat(32) });
    expect(await txOutputs(cfg, "missing")).toBeNull();
  });
});

describe("tx helpers", () => {
  it("redeemers are Close=0, Raise=1, Settle=2 (types.ak order)", () => {
    expect(Data.toCBORHex(Redeemer.settle())).toBe("d87b80");
    expect(Data.toCBORHex(Redeemer.close(0n, ""))).toBe("d8799f0040ff");
    expect(Data.toCBORHex(Redeemer.raise(3n, "00"))).toBe("d87a9f034100ff");
  });

  it("aligns times to preprod slots and starts Settle strictly after contest_end", () => {
    expect(alignMs(1_791_234_567_890n)).toBe(1_791_234_567_000n);
    expect(settleFromMs(1_791_234_567_000n)).toBe(1_791_234_568_000n);
    expect(settleFromMs(1_791_234_567_890n)).toBe(1_791_234_568_000n);
  });

  it("tops up the continuing output when the Closing datum needs more min-UTxO", () => {
    const d = { ...goldenDatum(), stage: { kind: "closing" as const, accepted: 3n, contestEnd: 1_791_234_567_000n } };
    const need = continuingLovelace(d, 2_000_000n, 1n);
    expect(need).toBeGreaterThan(2_000_000n);
    expect(continuingLovelace(d, 2_000_000n, 9_000_000n)).toBe(9_000_000n);
  });
});
