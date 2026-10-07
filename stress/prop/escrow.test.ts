// Property tests for the escrow money math, IOUs, datums and channel ids (packages/escrow).
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  closePayouts, decodePackDatum, deriveChannelId, encodePackDatum, isValidReceiptKey, newReceiptKey, parseIouHeader,
  receiptMessage, settleObligations, signCloseRequest, signReceipt, verifyCloseRequest, verifyReceipt, type PackDatum,
} from "@hirakumi/escrow";
import { BUYER, FEE, SELLER, goldenDatum } from "../../packages/escrow/test/golden.js";
import { runs } from "./runs";

const ADDRS = [BUYER, SELLER, FEE];
const big = (max: bigint) => fc.bigInt({ min: 0n, max });
const hex = (bytes: number) => fc.uint8Array({ minLength: bytes, maxLength: bytes }).map((b) => Buffer.from(b).toString("hex"));

/** A datum the gateway could lock: sane price, fee 0..1000 bps, any mix of equal / distinct addresses. */
const saneDatum = fc.record({
  pricePerCall: big(10_000_000n).map((p) => p + 1n),
  maxCalls: big(10_000n).map((m) => m + 1n),
  feeBps: big(1000n),
  seller: fc.constantFrom(...ADDRS),
  feeAddress: fc.constantFrom(...ADDRS),
  buyerRefund: fc.constantFrom(...ADDRS),
}).map((r) => ({ ...goldenDatum(), ...r }));

const tokensOf = (o: { tokens: bigint }[]) => o.reduce((s, x) => s + x.tokens, 0n);

describe("closePayouts / settleObligations: money is conserved", () => {
  it("seller + fee + buyer == locked, fee <= 10% of gross, nothing negative (sane datums, any accepted)", () => {
    fc.assert(fc.property(saneDatum, big(2n ** 64n - 1n), (d, accepted) => {
      const locked = d.pricePerCall * d.maxCalls;
      const p = closePayouts(d, locked, accepted);
      expect(p.seller + p.fee + p.buyer).toBe(locked);
      expect(p.sellerGross).toBe(p.seller + p.fee);
      expect(p.fee * 10_000n).toBeLessThanOrEqual(p.sellerGross * 1000n);
      expect(p.fee * 10_000n).toBeLessThanOrEqual(p.sellerGross * d.feeBps);
      for (const v of [p.seller, p.fee, p.buyer, p.sellerGross]) expect(v).toBeGreaterThanOrEqual(0n);
      // A buyer who accepted n <= maxCalls pays exactly n calls.
      if (accepted <= d.maxCalls) expect(p.sellerGross).toBe(accepted * d.pricePerCall);
    }), runs(2000));
  });

  it("hostile datums (any feeBps, negative price, more locked or less than promised) still conserve tokens", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), fc.bigInt({ min: -(10n ** 6n), max: 10n ** 6n }),
      fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.bigInt({ min: -(10n ** 6n), max: 2n ** 64n }),
      (price, feeBps, locked, accepted) => {
        const p = closePayouts({ pricePerCall: price, feeBps }, locked, accepted);
        expect(p.seller + p.fee + p.buyer).toBe(locked);
        expect(p.fee).toBeGreaterThanOrEqual(0n);
        expect(p.fee * 10n).toBeLessThanOrEqual(p.sellerGross);
        expect(p.buyer).toBeGreaterThanOrEqual(0n);
        expect(p.sellerGross).toBeLessThanOrEqual(locked);
      }), runs(2000));
  });

  it("settleObligations: per-address aggregation, sum of tokens == locked, buyer lovelace = locked - fee", () => {
    fc.assert(fc.property(
      saneDatum, big(10n ** 13n), big(10_000_000n).map((l) => l + 2_000_000n), big(2_000_000n), fc.boolean(),
      (d, accepted, lovelace, txFee, chargeFee) => {
        fc.pre(txFee <= lovelace);
        const locked = d.pricePerCall * d.maxCalls;
        const closing: PackDatum = { ...d, stage: { kind: "closing", accepted, contestEnd: 1n } };
        const obs = settleObligations(closing, { tokens: locked, lovelace }, txFee, { chargeFee });
        expect(tokensOf(obs)).toBe(locked);
        // One entry per address, no zero entries.
        expect(new Set(obs.map((o) => o.address)).size).toBe(obs.length);
        for (const o of obs) {
          expect(o.tokens > 0n || o.lovelace > 0n).toBe(true);
          expect(o.tokens).toBeGreaterThanOrEqual(0n);
          expect(o.lovelace).toBeGreaterThanOrEqual(0n);
        }
        const totalLovelace = obs.reduce((s, o) => s + o.lovelace, 0n);
        expect(totalLovelace).toBe(lovelace - (chargeFee ? txFee : 0n));
        // Each address gets exactly what its roles sum to.
        const p = closePayouts(closing, locked, accepted);
        for (const a of new Set([d.seller, d.feeAddress, d.buyerRefund])) {
          const want = (d.seller === a ? p.seller : 0n) + (d.feeAddress === a ? p.fee : 0n) + (d.buyerRefund === a ? p.buyer : 0n);
          expect(obs.find((o) => o.address === a)?.tokens ?? 0n).toBe(want);
        }
      }), runs(1500));
  });

  // Reachability note: a negative buyer lovelace needs txFee > locked lovelace. The datum caps closeFeeBudget at
  // 2 ADA and every lock carries min-UTxO ADA (> 1 ADA), and the gateway builds Settle with fee <= budget, so the
  // only way in is a caller passing an absurd fee. We pin the current behaviour so a change is noticed.
  it("txFee above the locked lovelace yields a negative buyer lovelace (caller must cap the fee)", () => {
    const d: PackDatum = { ...goldenDatum(), stage: { kind: "closing", accepted: 1n, contestEnd: 1n } };
    const obs = settleObligations(d, { tokens: 2_000_000n, lovelace: 1_000_000n }, 1_500_000n);
    expect(obs.find((o) => o.address === BUYER)!.lovelace).toBe(-500_000n);
  });
});

describe("IOUs", () => {
  const key = newReceiptKey();
  it("sign/verify round-trips; another channel, count, key or a flipped bit never verifies", () => {
    fc.assert(fc.property(hex(32), hex(32), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), fc.nat(63),
      (ch, other, n, m, bit) => {
        const sig = signReceipt(key.secretKey, ch, n);
        expect(verifyReceipt(key.publicKey, ch, n, sig)).toBe(true);
        if (other !== ch) expect(verifyReceipt(key.publicKey, other, n, sig)).toBe(false);
        if (m !== n) expect(verifyReceipt(key.publicKey, ch, m, sig)).toBe(false);
        const b = Buffer.from(sig, "hex");
        b[bit] ^= 1;
        expect(verifyReceipt(key.publicKey, ch, n, b.toString("hex"))).toBe(false);
        // A close request signature is never an IOU and vice versa (different prefixes).
        const close = signCloseRequest(key.secretKey, ch);
        expect(verifyCloseRequest(key.publicKey, ch, close)).toBe(true);
        expect(verifyReceipt(key.publicKey, ch, 0n, close)).toBe(false);
        expect(verifyCloseRequest(key.publicKey, ch, sig)).toBe(false);
      }), runs(150));
  });

  it("an IOU signed with another key never verifies", () => {
    const k2 = newReceiptKey();
    fc.assert(fc.property(hex(32), fc.nat(), (ch, n) => {
      expect(verifyReceipt(key.publicKey, ch, n, signReceipt(k2.secretKey, ch, n))).toBe(false);
    }), runs(100));
  });

  it("receiptMessage is 44 bytes, injective in (channel, count), rejects out-of-range counts", () => {
    fc.assert(fc.property(hex(32), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), (ch, n) => {
      const m = receiptMessage(ch, n);
      expect(m.length).toBe(44);
      expect(Buffer.from(m.subarray(36)).readBigUInt64BE()).toBe(n);
      expect(Buffer.from(m.subarray(4, 36)).toString("hex")).toBe(ch);
    }), runs(500));
    for (const bad of [-1n, 2n ** 64n, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
      expect(() => receiptMessage("00".repeat(32), bad as never)).toThrow();
    }
  });

  it("parseIouHeader never throws and only accepts <n>.<128 hex> with a safe integer n", () => {
    fc.assert(fc.property(fc.oneof(fc.string(), fc.fullUnicodeString(), fc.constant("1." + "a".repeat(128)),
      fc.tuple(fc.nat(), hex(64)).map(([n, s]) => `${n}.${s}`),
      fc.tuple(fc.bigInt({ min: 0n, max: 10n ** 20n }), hex(64)).map(([n, s]) => `${n}.${s.toUpperCase()}`)), (s) => {
      let r: ReturnType<typeof parseIouHeader> = null;
      expect(() => { r = parseIouHeader(s); }).not.toThrow();
      if (r) {
        const parsed = r as { accepted: number; signature: string };
        expect(Number.isSafeInteger(parsed.accepted)).toBe(true);
        expect(parsed.signature).toMatch(/^[0-9a-f]{128}$/);
        expect(s).toMatch(/^(0|[1-9][0-9]*)\.[0-9a-fA-F]{128}$/);
      }
    }), runs(3000));
    // Leading zeros, signs, spaces, exponents are refused.
    for (const h of ["01." + "a".repeat(128), "-1." + "a".repeat(128), "1e3." + "a".repeat(128), " 1." + "a".repeat(128), "1." + "a".repeat(127)]) {
      expect(parseIouHeader(h)).toBeNull();
    }
    expect(parseIouHeader(undefined as never)).toBeNull();
    expect(parseIouHeader(5 as never)).toBeNull();
  });

  it("isValidReceiptKey never throws on random input; random fresh keys always pass", () => {
    fc.assert(fc.property(fc.oneof(hex(32), fc.string(), hex(31), hex(33)), (k) => {
      expect(() => isValidReceiptKey(k)).not.toThrow();
    }), runs(1000));
    for (let i = 0; i < 50; i++) expect(isValidReceiptKey(newReceiptKey().publicKey)).toBe(true);
    // Small-order points (identity, order 2 and 4 points) are refused.
    for (const k of ["01" + "00".repeat(31), "ec" + "ff".repeat(30) + "7f", "00".repeat(32), "00".repeat(31) + "80"]) {
      expect(isValidReceiptKey(k)).toBe(false);
    }
  });
});

describe("datum encode/decode", () => {
  const datum = fc.record({
    channelId: hex(32), receiptKey: hex(32), policyId: hex(28), assetName: fc.integer({ min: 0, max: 32 }).chain((n) => hex(n)),
    ruleHash: hex(32), closer: hex(28),
    pricePerCall: fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }), maxCalls: fc.bigInt({ min: 0n, max: 2n ** 64n }),
    feeBps: fc.bigInt({ min: 0n, max: 10_000n }), contestPeriod: fc.bigInt({ min: 0n, max: 2n ** 63n }),
    closeFeeBudget: fc.bigInt({ min: 0n, max: 2n ** 63n }),
    buyerRefund: fc.constantFrom(...ADDRS), seller: fc.constantFrom(...ADDRS), feeAddress: fc.constantFrom(...ADDRS),
    stage: fc.oneof(fc.constant({ kind: "open" as const }), fc.record({
      kind: fc.constant("closing" as const), accepted: fc.bigInt({ min: 0n, max: 2n ** 64n }), contestEnd: fc.bigInt({ min: 0n, max: 2n ** 63n }),
    })),
  });
  it("decode(encode(d)) == d and encode is deterministic", () => {
    fc.assert(fc.property(datum, (d) => {
      const cbor = encodePackDatum(d as PackDatum);
      expect(decodePackDatum(cbor)).toEqual(d);
      expect(encodePackDatum(decodePackDatum(cbor.toUpperCase()))).toBe(cbor);
    }), runs(300));
  });
  it("decoding random bytes throws cleanly (never hangs, never returns a datum)", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
      try { decodePackDatum(Buffer.from(b).toString("hex")); } catch (e) { expect(e).toBeInstanceOf(Error); }
    }), runs(2000));
  });
  // Found by this suite: a 5-byte datum declaring a 2^31-element array ran the whole process out of memory, and
  // other short ones spun the CPU for 30 s or hung. Anyone can put such a datum in an output at the escrow address
  // (e.g. an extra output in their own Close tx), and the ChannelWatcher decodes every output at that address.
  // Each input runs in its own process so a regression fails the test instead of killing the test runner.
  it("hostile CBOR (huge declared lengths, bad indefinite items) is refused fast without exhausting memory", () => {
    const hostile = [
      "9a7fffffff", "9b00000000ffffffff00", "ba2666a6d1d117c7b8901b62976267f4bf909a28",
      "bf553ad74749b264136db2c4ddba9063c15e3be582233f5ad635ebb3", "5a7fffffff00", "bb7fffffffffffffff",
      "d8799f" + "9f".repeat(5000), "9f".repeat(100_000),
    ];
    const script = `const { decodePackDatum } = await import("@hirakumi/escrow");
      for (const h of JSON.parse(process.argv[1])) { const t = Date.now();
        try { decodePackDatum(h); console.log("DECODED", h.slice(0, 20)); } catch { }
        if (Date.now() - t > 1000) console.log("SLOW", h.slice(0, 20), Date.now() - t); }
      console.log("OK");`;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--max-old-space-size=256", "--input-type=module", "-e", script, JSON.stringify(hostile)],
      { cwd: import.meta.dirname, encoding: "utf8", timeout: 60_000 });
    expect(r.stdout.trim()).toBe("OK");
  });

  it("a single flipped byte in a valid datum never decodes to the same datum", () => {
    const cbor = encodePackDatum(goldenDatum());
    fc.assert(fc.property(fc.nat(cbor.length / 2 - 1), fc.integer({ min: 1, max: 255 }), (i, x) => {
      const b = Buffer.from(cbor, "hex");
      b[i] ^= x;
      let d: PackDatum | null = null;
      try { d = decodePackDatum(b.toString("hex")); } catch { return; }
      expect(d).not.toEqual(goldenDatum());
    }), runs(1000));
  });
});

describe("deriveChannelId", () => {
  const ids = fc.string({ maxLength: 40 });
  it("is 32-byte hex, deterministic, and changes with every field (no field shifting)", () => {
    fc.assert(fc.property(ids, ids, hex(32), fc.constantFrom(...ADDRS), hex(16), ids, (apiId, packId, rk, refund, nonce, extra) => {
      const base = { apiId, packId, receiptKey: rk, refundAddress: refund, quoteNonce: nonce };
      const id = deriveChannelId(base);
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      expect(deriveChannelId(base)).toBe(id);
      if (extra.length) {
        // Moving characters from packId into apiId must not collide (length-prefixed fields).
        expect(deriveChannelId({ ...base, apiId: apiId + extra, packId })).not.toBe(deriveChannelId({ ...base, apiId, packId: extra + packId }));
      }
      expect(deriveChannelId({ ...base, quoteNonce: nonce.replace(/^./, (c) => (c === "0" ? "1" : "0")) })).not.toBe(id);
    }), runs(500));
  });
});
