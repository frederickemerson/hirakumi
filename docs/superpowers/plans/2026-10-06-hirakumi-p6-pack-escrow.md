# Hirakumi P6 — Pack Escrow with Buyer-Signed Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status:** proposed on 6 Oct 2026, 18:05 SGT (about hour 6). Owner: **P6** (new workstream). Touches P1's gateway and P5's buyer. Read "Contract v1.2 amendments (proposed)" at the end, and get P1 and P5 to agree to it before Task 5.

**Goal:** A buyer agent's pack money goes into an on-chain escrow instead of straight to the seller. After each response that keeps the promise, the buyer agent signs a running receipt ("I accept N calls"). When the pack closes, one Cardano transaction pays the seller `N × price` and returns everything else to the buyer. Hirakumi can't overcharge, because only the buyer's signature unlocks seller money. Packs close when the buyer is done (or every call is used). A far-off safety deadline (seller's choice, default 90 days) is the escape hatch: if nobody closes by then, anyone can return the whole pack to the buyer.

**Why:** This removes weakness #1 from the review. Today, pack money goes to the seller at purchase and the "only pay on pass" promise lives only in Hirakumi's Postgres. After this change, the promise is enforced by a Cardano validator and the buyer's own key.

**Architecture:** One small unparameterized Plutus V3 validator (`pack_escrow`, Aiken) at a single script address. The x402 `exact` scheme's **`script` asset transfer method** locks the pack: the server supplies the inline datum in `extra.datum`, and the client attaches it to the `payTo` output. The gateway still issues the bearer token and reserves credits as today. It also gates each paid call on the buyer's latest receipt, so at most the seller's chosen number of passing calls (default 1) are ever unpaid. On close, the seller's share is split with Hirakumi's 3% fee inside the contract. A `ChannelCloser` job in the gateway builds the close transaction. A `ChannelSweeper` returns expired packs to their buyers. Direct-to-seller packs stay available behind `PACK_MODE=direct` as the fallback.

**Tech Stack:** Aiken v1.1.x with stdlib v2 (Plutus V3), `@meshsdk/core` for spending transactions (Lucid Evolution is the fallback if Mesh fights us on V3 inline-datum spends), `@noble/curves/ed25519` for receipts, Blockfrost preprod, `@x402/*` **2.26.0 exactly**, plus everything already in the P1 and P5 plans.

**Spec:** `docs/superpowers/specs/2026-10-06-hirakumi-design.md` (v4; §6.1 is superseded by this plan once the hour-19 gate passes)
**Contract:** `docs/superpowers/plans/2026-10-06-hirakumi-00-contract.md` + the v1.2 amendments at the end of this file
**x402 Cardano scheme:** `docs/reference/scheme_exact_cardano.md`, section "Script assetTransferMethod Schema" and "Script assetTransferMethod — additional rules"

---

## Decisions already made (6 Oct, with the lead)

| Decision | Choice |
|---|---|
| Who decides how many calls the seller is paid for | **Buyer-signed cumulative receipts**, verified on-chain with `verify_ed25519_signature` |
| Direct packs | Kept behind `PACK_MODE=direct` as the fallback; `PACK_MODE=escrow` is the demo default once the hour-19 gate passes |
| Contract author | Experienced in Aiken (estimate: validator + tests in 4–5 hours) |
| Owner | New workstream, P6 |
| Unsigned allowance (how many passing calls may be served before the next receipt) | **The seller's choice, per pack**, set on the pricing screen (default 1, allowed 1…`calls`). Stored in `packs.unsigned_allowance`, shown to the buyer in the 402 offer before they pay. Off-chain gateway policy only; the validator doesn't need it. |
| Hirakumi take rate | **In the contract.** The datum carries `fee_address` and `fee_bps` (300 = 3%). On close the seller's share is split: Hirakumi gets `floor(seller_gross × fee_bps / 10 000)`, the seller gets the rest. No fee on refunds or reclaims. |
| Pack lifetime | **No practical time limit.** A pack closes when the buyer says "done" or uses every call. A **safety deadline** exists only as an escape hatch: `packs.lifetime_days`, the seller's choice, default **90**, allowed 1–365 (`DEMO_MODE`: 20 minutes). One day before it, Hirakumi closes with the latest receipt; after it, anyone can return the whole pack to the buyer. |
| Who pays to close | **Split.** The **buyer pays the network fee**, out of the ADA they locked, capped by `close_fee_budget` in the datum (default 0.7 ADA). The contract checks the buyer gets back at least `locked_lovelace − tx.fee`, so nobody can take more than the real fee. **Hirakumi pays the min-ADA** of the seller's and its own fee payout (~1.2 ADA each; the fee one comes back to Hirakumi, so its net cost is ~1.2 ADA per close). |
| Who may submit a normal close | **Only Hirakumi's operator key** (`closer` in the datum, checked against `extra_signatories`). Otherwise a buyer could close with an old, lower receipt and underpay the seller. Reclaim after the safety deadline needs no signature. |

## Defaults chosen in this plan

| Topic | Default | Why |
|---|---|---|
| Settlement | **Once per pack**, at close | One spend transaction. Batched partial payouts need a continuing UTxO and double the validator logic. |
| Receipt key | A **fresh ed25519 key per pack**, generated by the buyer agent | CIP-8/COSE wallet signatures are painful to verify on-chain. A raw ed25519 key is one builtin call. |

---

## How it works (the picture to keep in your head)

```
 BUY  ── buyer agent ──POST /packs/:packId (X-Hirakumi-Receipt-Key, X-Hirakumi-Refund-Address)──► gateway
           ◄──402: exact / script / payTo = pack_escrow address / extra.datum = PackDatum(CBOR)──
      ── signs lock tx (100 calls × 0.02 tUSDM + ~2 ADA, inline datum) ──► facilitator settles
           ◄──200 { token, channelId, closeDeadline }      (onAfterSettle: channel 'locked', outref saved)

 USE  call 1 ── Bearer token ──► gateway ── upstream ── promise PASS ──► 200, X-Hirakumi-Sign-Next: 1
      buyer checks the promise itself, signs "HKR1 | channelId | 1"
      call 2 ── Bearer + X-Hirakumi-Receipt: 1.<sig> ──► FAIL ──► 422, nothing to sign
      call 3 ── Bearer + X-Hirakumi-Receipt: 1.<sig> ──► PASS ──► 200, X-Hirakumi-Sign-Next: 2
      call 4 ── Bearer, no new receipt ──► 402 { error: "receipt_required", signNext: 2 }   (seller's allowance = 1, used up)

CLOSE ── when the buyer says done, the pack is used up, or 1 day before the safety deadline ──
      gateway closer: spend lock with Close{accepted: 2, signature}
        seller_gross = 2 × 0.02 = 0.04 tUSDM; fee = 3% = 0.0012
        → output A: seller   0.0388 tUSDM (+ min-ADA)              tagged with channelId
        → output B: Hirakumi 0.0012 tUSDM (+ min-ADA)              tagged with channelId
        → output C: buyer    98 × 0.02 tUSDM + locked ADA − network fee   tagged with channelId
      (signed by Hirakumi's operator key; Hirakumi adds the min-ADA for outputs A and B)

 LATE ── nobody closed by the safety deadline (default 90 days) ── anyone spends with Reclaim → buyer gets 100% of the tokens back
```

What each party has to trust:

| Party | Can they take money they shouldn't? |
|---|---|
| Hirakumi | No. Seller money needs the buyer's signature; refund money can only go to the buyer's refund address; the ADA taken from the buyer is at most the real network fee, capped at 0.7 ADA. Hirakumi can only *fail to close*, and then the buyer reclaims everything after the safety deadline. |
| Seller | No. Same reason. |
| Buyer | Can't close with an old, lower receipt: a normal close needs Hirakumi's key. Can refuse to sign for a passing call. The gateway stops serving after the seller's chosen allowance of unsigned passes, so the seller loses at most that many calls, a risk the seller picked. |
| Hirakumi's fee | Fixed in the datum at purchase (`fee_bps`), paid only out of the seller's share, and only on calls the buyer signed for. |
| The promise check | Runs in two places: the gateway decides whether to return 200, and the buyer re-checks the same published rule (`/r/:ruleHash`) before signing. They have to agree for money to move. |

---

## Global Constraints (copy exact values)

- **Preprod only** (`cardano:preprod`). Every address starts with `addr_test1`. The buyer's refund address and the seller address must be **key-credential** addresses (`addr_test1q…` or `addr_test1v…`), never script addresses, and never the `pack_escrow` address itself.
- `@x402/*` pinned to **2.26.0** (root `pnpm.overrides`, as in P1).
- Pack asset: `USDM_PREPROD_ASSET` = policy `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9`, asset name `0014df10745553444d`. **Not** the Masumi escrow unit.
- Amounts are integer **micros** (6 decimals). Price per call = `price_micros / calls` and **must divide exactly**. The web price form enforces this in escrow mode (2 000 000 / 100 = 20 000).
- The receipt message is exactly `"HKR1" (4 ASCII bytes) ‖ channel_id (32 bytes) ‖ accepted (8-byte unsigned big-endian)` = 44 bytes. The signature is 64 bytes of raw ed25519. Never sign a hash of it; never use a different encoding.
- `channel_id` = `sha256( "hk-channel" ‖ apiId ‖ packId ‖ receiptKey(32) ‖ refundAddressBytes ‖ quoteNonce(16) )`. It's 32 bytes, created when the quote is created.
- Safety deadline: `close_deadline` = lock time + `packs.lifetime_days` (default 90, 1–365). The closer runs `CLOSE_MARGIN` before it: 1 day in production, 3 min in `DEMO_MODE=1`, where the lifetime is forced to 20 min. Paid calls stop at the same margin.
- `close_fee_budget` = `CLOSE_FEE_BUDGET_LOVELACE` (default 700 000). The close and reclaim transactions must have `fee ≤ close_fee_budget`, and the buyer's refund must carry ≥ `locked_lovelace − fee` lovelace.
- `closer` = the payment key hash of `OPERATOR_MNEMONIC`'s first address. A `Close` must be signed by it.
- Unsigned allowance: per pack, `packs.unsigned_allowance`, integer `1 ≤ n ≤ calls`, default `1`. Copied into `pack_channels` at quote time, so a later change by the seller doesn't affect packs already sold.
- Fee: `HIRAKUMI_FEE_ADDRESS` (key-credential preprod address) and `HIRAKUMI_FEE_BPS=300`. The validator accepts `0 ≤ fee_bps ≤ 1000`. Fee = `floor(seller_gross × fee_bps / 10000)`; the seller gets `seller_gross − fee`.
- `seller`, `buyer_refund` and `fee_address` must be **three different addresses**. The validator enforces this; otherwise one output could satisfy two payout checks and the transaction submitter could keep the difference.
- **Never** let a lock be offered without a datum. A script output without a datum strands the funds, and neither x402 nor the facilitator will catch it (spec: "the server owns datum correctness").

## Review Focus (the six failure modes most likely to cost real money)

1. **Funds stranded at the script.** The datum the gateway publishes doesn't decode as `PackDatum`, the lovelace is below min-UTxO, or an address field is wrong. → Tests: Task 3 `datum golden vector decodes in Aiken`; Task 5 `quote datum round-trips and passes validateDatumForLock`; Task 1 S1 spends a real lock on preprod.
2. **Seller paid without a valid receipt, or more than the receipt says.** → Aiken tests in Task 2: `close rejects bad signature`, `close rejects underpaying buyer`, `close rejects overpaying seller via a second script input`, `close rejects missing tag`.
3. **Buyer's ADA taken by whoever submits the close.** The validator must give the buyer at least `locked_lovelace − tx.fee`, with the fee capped by `close_fee_budget`. → Task 2 `close_rejects_buyer_lovelace_below_locked_minus_fee`, `close_rejects_fee_above_budget`, `reclaim_rejects_fee_above_budget`.
6. **The seller underpaid by a buyer closing with an old receipt.** → Task 2 `close_rejects_without_closer_signature`; Task 4 Step 4 tries it on preprod.
4. **Gateway serves unlimited calls without receipts** (the seller's risk), or **demands receipts for failed calls** (the buyer's risk). → Task 6 `third pass without receipt gets 402 receipt_required`, `422 needs no new receipt`, `receipt race with two concurrent calls`.
5. **Off-chain and on-chain receipt bytes disagree**, so every close fails at the deadline and sellers are never paid. → Task 3 golden vector: a TS-generated signature is verified inside an Aiken test.

---

## File Structure

```
contracts/pack-escrow/                      # P6, Aiken project (not a pnpm workspace member)
  aiken.toml                                # stdlib v2, plutus v3
  validators/pack_escrow.ak                 # T2 the validator
  lib/hirakumi/receipt.ak                   # T2 receipt_message(channel_id, accepted)
  lib/hirakumi/payout.ak                    # T2 pays_tagged(outputs, address, policy, name, qty, min_lovelace, tag)
  validators/pack_escrow.tests.ak           # T2 + T3 golden vectors
  plutus.json                               # generated by `aiken build`; committed
packages/escrow/                            # P6, @hirakumi/escrow
  package.json, tsconfig.json
  src/blueprint.ts                          # T3 loads plutus.json: script CBOR, hash, preprod address
  src/datum.ts                              # T3 PackDatum encode/decode (CBOR hex), validateDatumForLock
  src/receipt.ts                            # T3 newReceiptKey, receiptMessage, signReceipt, verifyReceipt, parseReceiptHeader
  src/channelId.ts                          # T3 deriveChannelId
  src/chain.ts                              # T4 findLockOutput(txCbor|txHash), getUtxo(outref) via Blockfrost
  src/close.ts                              # T4 buildCloseTx(...) and buildReclaimTx(...) (Mesh), submit
  test/*.test.ts                            # vitest; golden vectors shared with Aiken
db/migrations/0004_pack_channels.sql        # T5 P6 (P1 reviews)
apps/gateway/src/packEscrow.ts              # T5 quote + x402 script offer + onAfterSettle channel lock
apps/gateway/src/receipts.ts                # T6 receipt gate inside the credit call path
apps/gateway/src/channelJobs.ts             # T7 ChannelCloser + ChannelSweeper
apps/gateway/src/routes/channels.ts         # T7 POST /a/:apiId/channels/:channelId/{receipt,close}, GET status
agents/buyer/src/receipts.ts                # T8 key store per pack, local promise check, sign
agents/buyer/src/escrowPackFlow.ts          # T8 buy → call → sign → close
scripts/escrow-spike/                       # T1 throwaway spike files (not shipped)
```

---

## Timeline (SGT, hour numbers counted from the 12:00 Oct 6 start)

| Time | Hour | P6 work | Gate |
|---|---|---|---|
| Tue 18:00–19:45 | 6–7.75 | **Task 1** spikes S1–S5 | **Go/no-go at 19:45:** S1 + S3 must pass, or switch to fallback F1 |
| 19:45–00:00 | 7.75–12 | **Task 2** validator + Aiken tests | `aiken check` green |
| 00:00–02:30 | 12–14.5 | **Task 3** `@hirakumi/escrow` datum, receipt, golden vectors | Cross-language vector passes |
| 02:30–05:00 | 14.5–17 | **Task 4** close and reclaim builders; real preprod close by script | Cardanoscan shows the split |
| 05:00–07:00 | 17–19 | **Tasks 5–7** gateway integration (pair with P1, who has finished Task 15 by hour 16) | |
| 07:00 | **19** | **Hour-19 gate:** end-to-end on preprod: lock via x402 → 3 pass / 2 fail → close → split visible | Miss → `PACK_MODE=direct` for the demo, keep a pre-recorded close clip if Task 4 worked |
| 07:00–09:00 | 19–21 | **Task 8** buyer agent (pair with P5); **Task 9** dashboard rows (P2) | |
| 09:00–10:00 | 21–22 | **Task 10** rehearsal ×2, demo script update | Feature freeze at hour 22 |

This is tight but realistic only because the validator is small. If any task overruns by more than 90 minutes, cut in this order: Task 9 (dashboard) → buyer-initiated early close (closer handles "used up" and deadline only) → the sweeper (do the reclaim by hand once on camera) → the seller's allowance setting on the pricing screen (fix it at 1).

---

### Task 1: Feasibility spikes (hour 6–7.75, no repo code)

**Files:** `scripts/escrow-spike/` only. Work from the installed x402-express template, as in P1 Task 0.

Run them in this order. S1 decides the whole plan.

- [ ] **S1 — x402 `script` lock with an inline datum, through the hosted facilitator, using `@x402/cardano@2.26.0` (the most important one).**
  Compile a throwaway Aiken validator that always succeeds for spend (`validator always { spend(_d, _r, _o, _t) { True } else(_) { fail } }`), take its CBOR from `plutus.json`, and serve a route with:
  ```ts
  accepts: { scheme: "exact", network: "cardano:preprod", payTo: SCRIPT_ADDR, maxTimeoutSeconds: 600,
    price: { amount: "100000", asset: USDM_PREPROD_ASSET },
    extra: { assetTransferMethod: "script", confirmationPolicy: { l1Confirmations: 0 },
             script: { type: "plutusV3", code: SCRIPT_CBOR }, datum: "d8799f4568656c6c6fff" } }
  ```
  Pay with the spike buyer (`wrapFetchWithPayment`, spend cap set). Check:
  1. Does `@x402/cardano/exact/client` 2.26.0 implement `script` at all? Grep `node_modules/@x402/cardano/dist/esm` for `assetTransferMethod` and `"script"` **before** writing code.
  2. Is the output at `SCRIPT_ADDR` carrying the inline datum exactly? Check with `curl $BF/txs/<hash>/utxos | jq '.outputs[] | {address, inline_datum, amount}'`.
  3. How much lovelace did the client put on the output? It must be ≥ the min-UTxO of a ~300-byte datum plus one token (expect ~1.6–2.0 ADA). Record the number. **Then check the buyer pays the close fee:** `locked_lovelace − 700 000` must still be ≥ the min-ADA of the buyer's refund output (token + 34-byte tag datum, expect ~1.2 ADA). The lock output's big datum needs more min-ADA than the small refund output, and that difference is what pays the fee. If it's short: look for a way to make the x402 client add lovelace to the script output; otherwise lower the budget to what fits and **Hirakumi tops up the buyer's output** (record it as a known cost), or use F1, where the buyer builds the lock and can add any amount.
  4. Did `onAfterSettle` fire with `ctx.result.transaction`?
  **Pass:** the lock lands with the datum. **Fail:** go to fallback F1 (below) and tell the team at 19:45.

- [ ] **S2 — Spend that lock on preprod with Mesh.** Use `MeshTxBuilder` with `spendingPlutusScriptV3()`, `txIn(...)`, `txInInlineDatumPresent()`, `txInRedeemerValue(mConStr0([]))`, `txInScript(SCRIPT_CBOR)`, collateral from the operator wallet, and `invalidHereafter(slot)`. **Pass:** the token returns to a test address. **Fail:** try Lucid Evolution's `collectFrom(utxos, redeemer).attach.SpendingValidator(...)`. If both fail in 45 minutes → fallback F2.

- [ ] **S3 — The 402 and the paid retry must produce identical requirements.** `@x402/express` re-runs `DynamicPrice` on the paid request and matches the client's `accepted` against it. Check in `node_modules/@x402/core/dist/esm` how matching is done (deep equality on `extra`? only `scheme/network/asset/payTo/amount`?). Then confirm that a `DynamicPrice` reading request headers through `HTTPRequestContext` (look for `adapter.getHeader` or `request.headers` in the `.d.mts`) can return the same `extra.datum` twice when the headers are the same. **Pass:** the quote-by-headers design works. **Fail:** add `X-Hirakumi-Quote: <quoteId>` on the retry and look the quote up by id (Task 5 already stores quotes, so this is a small change).

- [ ] **S4 — `verify_ed25519_signature` with a TS-made signature.** Make a key with `@noble/curves/ed25519`, sign the 44-byte message for `channel_id = 0x00…01`, `accepted = 7`, and paste the hex into an Aiken test that calls `builtin.verify_ed25519_signature(vk, msg, sig)`. **Pass:** `aiken check` green. This becomes the golden vector in Task 3.

- [ ] **S5 — Does the facilitator reject anything about our lock?** The facilitator rejects transactions with `mint`, withdrawals or certificates (rule 6) and checks min-UTxO (rule 8). Our lock has none of the first three. Note the exact rejection text if rule 8 bites, then fix the lovelace on the client side (spike buyer option) or report it as F1.

Post this table in team chat at 19:45:

| Spike | Result | Numbers / notes |
|---|---|---|
| S1 x402 script lock + datum | pass / fail | lovelace on output = …, settle time = … s |
| S2 Mesh V3 spend | pass / fail (Lucid?) | fee = … ADA, ex-units = … |
| S3 requirements match on retry | headers / quoteId | matching fields = … |
| S4 ed25519 golden vector | pass / fail | |
| S5 facilitator rules | ok / issue | |

**Fallbacks:**
- **F1 (S1 fails: x402 can't lock to a script):** the buyer agent builds the lock transaction itself with Mesh from the same quote (`GET /a/:apiId/packs/:packId/quote` returns the datum and the script address) and posts the signed transaction to `POST /a/:apiId/packs/:packId/escrow` with the quote id. The gateway checks the output (address, datum bytes equal to the quote, tokens ≥ price, lovelace ≥ min) and submits it through Blockfrost. Everything after the lock is unchanged. The cost is that the purchase is no longer an x402 payment. Say so in the write-up. Direct x402 packs still exist as `PACK_MODE=direct`, so x402 is still shown.
- **F2 (S2 fails: we can't spend from TS):** stop. Direct packs only. Keep the validator and its tests in the repo, and describe this work as the roadmap with code in the write-up.

---

### Task 2: The `pack_escrow` validator (Aiken, hour 7.75–12)

**Files:**
- Create: `contracts/pack-escrow/aiken.toml`, `validators/pack_escrow.ak`, `lib/hirakumi/receipt.ak`, `lib/hirakumi/payout.ak`, `validators/pack_escrow.tests.ak`

**Interfaces:**
- Produces: `plutus.json` with one validator, `pack_escrow.pack_escrow.spend`, unparameterized, Plutus V3.
- Datum (field order is the CBOR order; `Constr 0`):

| # | Field | Type | Meaning |
|---|---|---|---|
| 0 | `channel_id` | ByteArray(32) | Unique pack id; also the output tag |
| 1 | `receipt_key` | ByteArray(32) | Buyer's ed25519 public key for receipts |
| 2 | `buyer_refund` | Address | Where refunds and all locked ADA go |
| 3 | `seller` | Address | Seller's verified address |
| 4 | `policy_id` | ByteArray(28) | tUSDM policy |
| 5 | `asset_name` | ByteArray | tUSDM asset name |
| 6 | `price_per_call` | Int | micros |
| 7 | `max_calls` | Int | e.g. 100 |
| 8 | `close_deadline` | Int | POSIX ms; the safety deadline (default lock + 90 days) |
| 9 | `rule_hash` | ByteArray(32) | sha256 of the promise; informational, binds the purchase to the promise |
| 10 | `fee_address` | Address | Hirakumi's fee address |
| 11 | `fee_bps` | Int | Take rate in basis points (300 = 3%), `0…1000` |
| 12 | `closer` | ByteArray(28) | Payment key hash of Hirakumi's operator wallet; must sign every `Close` |
| 13 | `close_fee_budget` | Int | Max lovelace the buyer pays towards the network fee of a close or reclaim |

- Redeemer: `Close { accepted: Int, signature: ByteArray }` = `Constr 0 [accepted, signature]`; `Reclaim` = `Constr 1 []`.

**Rules the validator enforces:**

| Path | Must hold |
|---|---|
| Both | Datum present and decodes. Exactly **one** input in the tx is at this script's payment credential (double-satisfaction guard). `seller`, `buyer_refund` and `fee_address` are pairwise different. `0 ≤ fee_bps ≤ 1000`. |
| `Close` | `0 ≤ accepted ≤ max_calls`; `seller_gross = accepted × price_per_call ≤ locked_tokens`; `fee = seller_gross × fee_bps / 10000` (integer division); `closer` is in `tx.extra_signatories`; the tx validity range is **entirely before** `close_deadline`; `tx.fee ≤ close_fee_budget`; `verify_ed25519_signature(receipt_key, receipt_message(channel_id, accepted), signature)`; an output to `seller` carries ≥ `seller_gross − fee` tokens (skipped when 0); an output to `fee_address` carries ≥ `fee` tokens (skipped when 0); an output to `buyer_refund` carries ≥ `locked_tokens − seller_gross` tokens **and** ≥ `locked_lovelace − tx.fee` lovelace. Every payout output carries inline datum `channel_id`. |
| `Reclaim` | The tx validity range is **entirely after** `close_deadline`; `tx.fee ≤ close_fee_budget`; an output to `buyer_refund` carries ≥ `locked_tokens` tokens and ≥ `locked_lovelace − tx.fee` lovelace, with inline datum `channel_id`. **No signature needed**, so the Hirakumi sweeper (or anyone) can trigger the refund. |

Note: `locked_tokens` is read from the spent UTxO, not from `price_per_call × max_calls`. If someone donates extra tokens to the UTxO, they go to the buyer, and a short lock can't make the close impossible.

- [ ] **Step 1: Write the failing tests first** (`validators/pack_escrow.tests.ak`). Build the `Transaction` with `transaction.placeholder` and override `inputs`, `outputs`, `validity_range`. Use the golden key and signatures from S4. Cover:
  - `close_pays_split` (accepted 62 of 100): passes
  - `close_zero_accepted_all_to_buyer`: passes (no seller output needed)
  - `close_all_accepted_buyer_gets_ada_only`: passes
  - `close_rejects_bad_signature` / `close_rejects_signature_for_other_channel` / `close_rejects_signature_for_other_count`
  - `close_rejects_accepted_above_max` / `close_rejects_negative`
  - `close_rejects_seller_underpaid` / `close_rejects_buyer_tokens_short` / `close_rejects_buyer_lovelace_short`
  - `close_rejects_missing_tag_on_buyer_output` / `close_rejects_wrong_tag`
  - `close_rejects_after_deadline` / `close_rejects_open_ended_validity` (no upper bound)
  - `close_rejects_two_script_inputs`
  - `close_pays_fee_3pct` (62 accepted × 20 000 = 1 240 000 gross → fee 37 200, seller 1 202 800): passes
  - `close_fee_rounds_down` (1 accepted × 333 micros at 300 bps → fee 9, seller 324): passes
  - `close_rejects_fee_short` / `close_rejects_seller_short_after_fee` / `close_rejects_fee_taken_from_buyer_refund`
  - `close_zero_fee_bps_needs_no_fee_output`: passes
  - `rejects_fee_bps_above_1000`
  - `close_rejects_without_closer_signature` (a buyer closing with an old receipt): fails
  - `close_rejects_fee_above_budget` / `close_rejects_buyer_lovelace_below_locked_minus_fee` / `reclaim_rejects_fee_above_budget`
  - `close_buyer_pays_exact_fee` (locked 2 000 000, fee 450 000 → buyer output ≥ 1 550 000): passes
  - `rejects_seller_equals_buyer_refund` / `rejects_fee_address_equals_seller` / `rejects_fee_address_equals_buyer_refund`
  - `reclaim_after_deadline_pays_buyer` / `reclaim_rejects_before_deadline` / `reclaim_rejects_short_refund`
  - `donated_tokens_go_to_buyer`

- [ ] **Step 2: Run them and watch them fail.** `cd contracts/pack-escrow && aiken check` → failures because the validator doesn't exist yet.

- [ ] **Step 3: Implement.** Sketch (check names against your stdlib version; `aiken docs` lists them):

`lib/hirakumi/receipt.ak`:
```aiken
use aiken/primitive/bytearray

pub const prefix: ByteArray = "HKR1"

/// 44 bytes: "HKR1" ‖ channel_id(32) ‖ accepted as 8-byte unsigned big-endian
pub fn receipt_message(channel_id: ByteArray, accepted: Int) -> ByteArray {
  prefix
    |> bytearray.concat(channel_id)
    |> bytearray.concat(bytearray.from_int_big_endian(accepted, 8))
}
```

`lib/hirakumi/payout.ak`:
```aiken
use aiken/collection/list
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId, lovelace_of, quantity_of}
use cardano/transaction.{InlineDatum, Output}

/// True when nothing is owed, or some output to `to` carries at least the amounts and is tagged.
pub fn pays_tagged(outputs: List<Output>, to: Address, policy: PolicyId, name: AssetName,
                   tokens: Int, lovelace: Int, tag: ByteArray) -> Bool {
  if tokens <= 0 && lovelace <= 0 {
    True
  } else {
    list.any(outputs, fn(o) {
      o.address == to && quantity_of(o.value, policy, name) >= tokens &&
        lovelace_of(o.value) >= lovelace && o.datum == InlineDatum(tag)
    })
  }
}
```

Note on `o.datum == InlineDatum(tag)`: `tag` is a `ByteArray`, but `InlineDatum` holds `Data`. Cast it with `let tag_data: Data = tag` first. Make the off-chain builder attach the tag as a plain bytes datum (CBOR `5820 <32 bytes>`).

`validators/pack_escrow.ak`:
```aiken
use aiken/builtin
use aiken/collection/list
use aiken/interval
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId, lovelace_of, quantity_of}
use cardano/transaction.{OutputReference, Transaction, find_input}
use hirakumi/payout.{pays_tagged}
use hirakumi/receipt.{receipt_message}

pub type PackDatum {
  channel_id: ByteArray,
  receipt_key: ByteArray,
  buyer_refund: Address,
  seller: Address,
  policy_id: PolicyId,
  asset_name: AssetName,
  price_per_call: Int,
  max_calls: Int,
  close_deadline: Int,
  rule_hash: ByteArray,
  fee_address: Address,
  fee_bps: Int,
  closer: ByteArray,
  close_fee_budget: Int,
}

pub type PackRedeemer {
  Close { accepted: Int, signature: ByteArray }
  Reclaim
}

validator pack_escrow {
  spend(datum: Option<PackDatum>, redeemer: PackRedeemer, own_ref: OutputReference, tx: Transaction) {
    expect Some(d) = datum
    expect Some(own) = find_input(tx.inputs, own_ref)
    let own_cred = own.output.address.payment_credential
    let script_inputs = list.count(tx.inputs, fn(i) { i.output.address.payment_credential == own_cred })
    let locked_tokens = quantity_of(own.output.value, d.policy_id, d.asset_name)
    let locked_lovelace = lovelace_of(own.output.value)
    let tag: Data = d.channel_id
    let distinct_parties = and {
        d.seller != d.buyer_refund,
        d.fee_address != d.seller,
        d.fee_address != d.buyer_refund,
      }

    script_inputs == 1 && distinct_parties && d.fee_bps >= 0 && d.fee_bps <= 1000 && when redeemer is {
      Close { accepted, signature } -> {
        let seller_gross = accepted * d.price_per_call
        let fee = seller_gross * d.fee_bps / 10000
        and {
          list.has(tx.extra_signatories, d.closer),
          tx.fee <= d.close_fee_budget,
          accepted >= 0,
          accepted <= d.max_calls,
          seller_gross <= locked_tokens,
          interval.is_entirely_before(tx.validity_range, d.close_deadline),
          builtin.verify_ed25519_signature(d.receipt_key, receipt_message(d.channel_id, accepted), signature),
          pays_tagged(tx.outputs, d.seller, d.policy_id, d.asset_name, seller_gross - fee, 0, tag),
          pays_tagged(tx.outputs, d.fee_address, d.policy_id, d.asset_name, fee, 0, tag),
          pays_tagged(tx.outputs, d.buyer_refund, d.policy_id, d.asset_name,
                      locked_tokens - seller_gross, locked_lovelace - tx.fee, tag),
        }
      }
      Reclaim -> and {
        interval.is_entirely_after(tx.validity_range, d.close_deadline),
        tx.fee <= d.close_fee_budget,
        pays_tagged(tx.outputs, d.buyer_refund, d.policy_id, d.asset_name, locked_tokens, locked_lovelace - tx.fee, tag),
      }
    }
  }

  else(_) {
    fail
  }
}
```
(Adjust `pays_tagged` to take `tag: Data`.) `is_entirely_before` must reject an open-ended upper bound; check the stdlib semantics in a test (`close_rejects_open_ended_validity`) rather than trusting the name.

- [ ] **Step 4: `aiken check` green, then `aiken build`.** Commit `plutus.json`. Record the script hash and the preprod address (`aiken address --testnet` or derive in TS in Task 3) in the plan's notes and team chat.

- [ ] **Step 5: Self-review with the `review-contract` Cardano skill** (`.claude/skills/review-contract/SKILL.md`). Look specifically at double satisfaction, unbounded validity ranges, datum-less outputs and the min-ADA of outputs. Fix and re-run. Commit: `feat(contracts): pack_escrow validator with buyer-signed receipts`.

---

### Task 3: `@hirakumi/escrow` — datum, channel id, receipts, golden vectors (hour 12–14.5)

**Files:** `packages/escrow/src/{blueprint,datum,channelId,receipt}.ts`, `packages/escrow/test/{datum,receipt}.test.ts`

**Produces:**
```ts
export const PACK_ESCROW: { scriptCbor: string; scriptHash: string; address: string /* preprod */ };
export type PackDatum = { channelId: string; receiptKey: string; buyerRefund: string; seller: string;
  policyId: string; assetName: string; pricePerCall: bigint; maxCalls: number; closeDeadline: number; ruleHash: string;
  feeAddress: string; feeBps: number; closer: string /* key hash hex */; closeFeeBudget: bigint };
export function closePayouts(d: PackDatum, lockedTokens: bigint, accepted: number):
  { seller: bigint; fee: bigint; buyer: bigint };               // the exact Aiken arithmetic, used by builder, gateway and buyer
export function encodePackDatum(d: PackDatum): string;          // CBOR hex, Constr 0, field order as Task 2
export function decodePackDatum(cborHex: string): PackDatum;
export function validateDatumForLock(d: PackDatum): void;       // throws: key-credential addresses, not escrow addr,
                                                                // 32-byte ids, divisible price, deadline in future
export function deriveChannelId(p: { apiId: string; packId: string; receiptKey: string; refundAddress: string; quoteNonce: string }): string;
export function newReceiptKey(): { secretKey: string; publicKey: string };
export function receiptMessage(channelId: string, accepted: number): Uint8Array;   // 44 bytes
export function signReceipt(secretKey: string, channelId: string, accepted: number): string;  // 64-byte hex
export function verifyReceipt(publicKey: string, channelId: string, accepted: number, sig: string): boolean;
export function parseReceiptHeader(v: string): { accepted: number; signature: string } | null;  // "<int>.<128 hex>"
```

- [ ] **Step 1: Failing tests.**
  - `receiptMessage` length 44, starts `48 4b 52 31`, ends with `00 00 00 00 00 00 00 07` for 7.
  - **Golden vector:** fixed secret key `0x01…20`; `signReceipt(sk, "00"*31+"01", 7)` equals the hex you pasted into the Aiken test in S4. Same vector, two languages.
  - `encodePackDatum` golden: build the same datum in an Aiken test with `cbor.serialise` and compare hex. Addresses must encode as Plutus `Address` (`Constr 0 [paymentCred, Option stakeCred]`). This is the classic place to get it wrong, so test a base address with a stake part **and** an enterprise address.
  - `validateDatumForLock` rejects: script refund address, refund = escrow address, price not divisible, deadline in the past, 31-byte channel id, `feeBps` outside 0…1000, any two of seller / refund / fee address equal.
  - `closePayouts` matches the Aiken test numbers exactly (62 accepted → seller 1 202 800, fee 37 200, buyer 760 000; the rounding case 9 / 324).
  - `parseReceiptHeader` rejects `"-1.<sig>"`, `"1.<short>"`, `"1e3.<sig>"`.
- [ ] **Step 2:** run → fail. **Step 3:** implement with `@meshsdk/core` `serializeData`/`deserializeDatum` (or `@meshsdk/core-cst`) for CBOR, `@noble/curves/ed25519` for keys, and `@meshsdk/core` `deserializeAddress` → `pubKeyHash`/`stakeCredentialHash` for the address-to-Plutus conversion. **Step 4:** green. Commit.

---

### Task 4: Close and reclaim transaction builders + a real preprod close (hour 14.5–17)

**Files:** `packages/escrow/src/{chain,close}.ts`, `packages/escrow/test/close.test.ts`, `scripts/escrow-spike/close-by-hand.ts`

**Produces:**
```ts
export function findLockOutput(txHash: string, bf: Blockfrost): Promise<{ outref: string; datum: PackDatum; lovelace: bigint; tokens: bigint } | null>;
export function buildCloseTx(p: { lock: Outref; datum: PackDatum; lovelace: bigint; tokens: bigint;
  accepted: number; signature: string; operator: MeshWallet; nowMs: number }): Promise<string /* signed tx cbor */>;
export function buildReclaimTx(p: { lock: Outref; datum: PackDatum; lovelace: bigint; tokens: bigint;
  operator: MeshWallet; nowMs: number }): Promise<string>;
export function submitTx(cbor: string, bf: Blockfrost): Promise<string /* tx hash */>;
```

Transaction shapes:
- **Close:** inputs = lock (script, redeemer `Close`) + one operator UTxO (min-ADA for the seller and fee outputs). Required signer = the operator key (`requiredSignerHash(closer)`), and the operator signs. Collateral = operator UTxO (≥ 5 ADA, pure ADA). Outputs = seller (`closePayouts().seller` tokens + min-ADA, inline datum = channel id bytes) if > 0; Hirakumi fee (`closePayouts().fee` tokens + min-ADA, same tag) if > 0; buyer refund (remaining tokens + `locked_lovelace − fee` lovelace, inline datum = channel id bytes); operator change. The network fee is taken from the locked lovelace, not from the operator. Build twice: once to learn the fee, then fix the buyer output to `locked − fee` and assert `fee ≤ closeFeeBudget`. `invalidHereafter` = slot(min(now + 10 min, closeDeadline − 1 min)). Do not set a stake/reward withdrawal.
- **Reclaim:** no seller or fee output and no required signer; the buyer output carries all tokens and `locked − fee`; the operator only supplies collateral. `invalidBefore` = slot(closeDeadline + 1 min).
- Convert ms to slots with Mesh's `resolveSlotNo("preprod", ms)`. **Never** assume 1 slot = 1 s outside the helper.

- [ ] **Step 1: Unit tests** with a fake Blockfrost/UTxO set: output amounts, tags, validity bounds, accepted 0 and max, "refuses to build if the receipt doesn't verify off-chain" (cheap pre-check before paying a fee for a failing script).
- [ ] **Step 2: Implement.** **Step 3: Unit tests green.**
- [ ] **Step 4: Real preprod run by hand** (`close-by-hand.ts`): lock 100 × 0.02 tUSDM via the S1 spike buyer with a real `PackDatum` (`closeDeadline` = now + 20 min) → sign receipt `accepted = 3` → `buildCloseTx` → submit. Check on Cardanoscan: seller has 0.0582 tUSDM, Hirakumi's fee address has 0.0018, buyer has 1.94 tUSDM back plus the locked ADA minus the close fee. Also try closing with the buyer's key instead of the operator's: it must fail. Then lock a second pack, wait past the deadline, `buildReclaimTx` → buyer gets 2.00 back. **Save both Cardanoscan links**; they're your demo fallback footage.
- [ ] **Step 5:** Commit: `feat(escrow): close and reclaim builders, verified on preprod`.

---

### Task 5: Gateway — escrow pack offer and lock (hour 17–18, pair with P1)

**Files:**
- Create: `db/migrations/0004_pack_channels.sql`, `apps/gateway/src/packEscrow.ts`, `apps/gateway/test/packEscrow.test.ts`
- Modify: `apps/gateway/src/packs.ts` (branch on `PACK_MODE`), `apps/gateway/src/app.ts`

**Migration:**
```sql
alter table packs add column unsigned_allowance int not null default 1
  check (unsigned_allowance >= 1 and unsigned_allowance <= calls);
alter table packs add column lifetime_days int not null default 90
  check (lifetime_days between 1 and 365);

create table pack_channels (
  id text primary key,                          -- 'ch_' + 10 random base32
  channel_id text not null unique,              -- 64 hex
  api_id text not null references apis(id),
  pack_id text not null references packs(id),
  credit_token_id text references credit_tokens(id),
  quote_key text not null,                      -- sha256(apiId|packId|receiptKey|refundAddress)
  receipt_key text not null,                    -- 64 hex
  buyer_refund_address text not null,
  seller_address text not null,
  price_per_call_micros bigint not null,
  max_calls int not null,
  close_deadline timestamptz not null,
  rule_hash text not null,
  unsigned_allowance int not null,              -- copied from packs at quote time
  fee_address text not null,
  fee_bps int not null,
  close_fee_budget_lovelace bigint not null,
  buyer_close_fee_lovelace bigint,              -- actual fee taken from the buyer at close
  datum_cbor text not null,
  status text not null check (status in ('quoted','locked','closing','closed','reclaimed','quote_expired')),
  lock_tx_hash text, lock_output_index int,
  passes_served int not null default 0,         -- passing calls delivered
  in_flight int not null default 0,             -- reserved calls not yet finished
  receipt_accepted int not null default 0,      -- highest valid receipt
  receipt_signature text,
  close_tx_hash text, seller_paid_micros bigint, fee_paid_micros bigint, buyer_refund_micros bigint,
  quote_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index on pack_channels (quote_key) where status = 'quoted';
create index on pack_channels (status, close_deadline);
```

**Behaviour of `POST /a/:apiId/packs/:packId` when `PACK_MODE=escrow`:**
1. 404 / 503 exactly as today (Down → 503 before any offer).
2. Require headers `X-Hirakumi-Receipt-Key` (64 hex) and `X-Hirakumi-Refund-Address` (`addr_test1`, key credential). Missing or bad → **400** `{ error: "receipt_key_required" }` or `{ error: "bad_refund_address" }`, with no offer.
3. Quote: `quote_key = sha256(apiId|packId|receiptKey|refundAddress)`. Reuse the open `quoted` row if `quote_expires_at > now`; otherwise insert a new one with a fresh `quoteNonce`, `channel_id`, `close_deadline`, and `datum_cbor = encodePackDatum(...)`. Run `validateDatumForLock` before inserting. `quote_expires_at` = now + `maxTimeoutSeconds` (600 s).
4. `DynamicPrice` returns `{ amount: price_micros, asset: USDM_PREPROD_ASSET, extra: { apiId, packId, calls, ruleHash, ruleUrl, channelId, closeDeadline, pricePerCall, unsignedAllowance, feeBps } }`. The route option's `extra` = `{ assetTransferMethod: "script", script: { type: "plutusV3", code: PACK_ESCROW.scriptCbor }, datum: row.datum_cbor, confirmationPolicy: { l1Confirmations: 0 } }`; `payTo` = `PACK_ESCROW.address`. (If S3 showed that dynamic `extra` must all go in the price's `extra`, move the script fields there.)
5. Paid request: the handler creates the pending credit token exactly as today **and** links it: `update pack_channels set credit_token_id = $token where id = $ch`. The 200 body adds `channelId`, `closeDeadline`, `escrowAddress`.
6. `onAfterSettle`: activate the token (existing code), then `findLockOutput(tx)` → check the output's inline datum **equals** `datum_cbor`, tokens ≥ `price_micros`, address = escrow → `status = 'locked'`, save outref. If the datum doesn't match: log loudly, keep the token **pending**, and mark the channel `quoted`. (Funds are safe: the sweeper can't help here, but the datum came from us, so this "can't happen" check guards against a client bug.)
7. The reconciler (P1 Task 14) gets one more case: for `quoted` channels with a token whose tx is found on chain, run step 6.

- [ ] **Step 1: Failing tests** (`packEscrow.test.ts`, with the fake facilitator from the P1 harness):
  - 402 offers `payTo = PACK_ESCROW.address`, `extra.assetTransferMethod = "script"`, `extra.datum` decodes to a `PackDatum` with the right seller, price per call 20 000, 100 calls, and the receipt key from the header.
  - The same headers twice give **byte-identical** `extra.datum` (quote reuse); different receipt keys give different channel ids.
  - Missing receipt-key header → 400 with no `PAYMENT-REQUIRED` header.
  - Paid → 200 `{ token, credits: 100, channelId }`; after settle the channel is `locked` with the outref.
  - Datum mismatch in the settled tx → token stays pending.
  - `PACK_MODE=direct` → the old behaviour, byte for byte (re-run P1's `packs.test.ts` with the flag).
- [ ] **Step 2–4:** fail → implement → green. Commit.

---

### Task 6: Gateway — the receipt gate on paid calls (hour 18–18.5)

**Files:** `apps/gateway/src/receipts.ts`, modify the credit path in `apps/gateway/src/credits.ts`, `apps/gateway/test/receipts.test.ts`

**Rules** (only when the token belongs to an escrow channel; direct tokens are untouched):
1. If the request carries `X-Hirakumi-Receipt: <accepted>.<sig>`: parse it; `verifyReceipt(receipt_key, channel_id, accepted, sig)` must pass (otherwise **401** `{ error: "bad_receipt" }`), and `accepted ≤ passes_served` (otherwise **401** `{ error: "receipt_ahead" }`). If `accepted > receipt_accepted`, store it with an atomic `update … where receipt_accepted < $accepted`.
2. **Gate before reserving a credit**, in the same statement as the reservation:
   ```sql
   update pack_channels set in_flight = in_flight + 1, updated_at = now()
   where id = $1 and status = 'locked' and close_deadline > now() + $CLOSE_MARGIN
     and (passes_served + in_flight) - receipt_accepted < unsigned_allowance
   returning *
   ```
   `unsigned_allowance` is the channel's own column (the seller's choice at the time of sale).
   No row → **402** `{ error: "receipt_required", signNext: passes_served, channelId }` (or **409** `{ error: "channel_closing" }` if the status isn't `locked`).
3. Then run the existing credit reserve → upstream → rule.
   - **Pass:** `passes_served += 1, in_flight -= 1`; respond 200 with `X-Credits-Remaining` and **`X-Hirakumi-Sign-Next: <passes_served>`**.
   - **Fail / 502 / 504:** `in_flight -= 1` only; 422/502/504 as today. Nothing to sign.
4. If `passes_served == max_calls` after a pass, enqueue a close (Task 7).

- [ ] **Failing tests:** with allowance 3, three passes are served without receipts and the fourth gets 402; a seller changing `packs.unsigned_allowance` doesn't change an existing channel; first call without a receipt passes (allowance 1) and returns `Sign-Next: 1`; second call without a receipt → 402 `receipt_required`, `signNext: 1`; with a valid `1.<sig>` → 200 `Sign-Next: 2`; 422 leaves `passes_served` unchanged and the next call is allowed; forged sig → 401 `bad_receipt`; `5.<sig>` when 2 served → 401 `receipt_ahead`; an older receipt never lowers `receipt_accepted`; two concurrent calls with allowance 1 → exactly one reaches upstream; a call inside the close margin → 409 `channel_closing`.
- [ ] Implement → green → commit.

---

### Task 7: Gateway — closer, sweeper and channel routes (hour 18.5–19)

**Files:** `apps/gateway/src/channelJobs.ts`, `apps/gateway/src/routes/channels.ts`, tests

- **`ChannelCloser`** (every 15 s): picks channels where `status = 'locked'` and (a) `passes_served = max_calls`, or (b) the buyer asked to close, or (c) `close_deadline − CLOSE_MARGIN < now` (1 day in production, 3 min in demo mode). There is no other trigger: an idle pack stays open until the buyer is done or the safety deadline approaches. Sets `status = 'closing'` (conditional update, so only one worker wins), waits for `in_flight = 0` (max 20 s), then `buildCloseTx(accepted = receipt_accepted)` → submit → save `close_tx_hash`, payouts → `closed` after Blockfrost shows the tx. On submit failure: back to `locked` with a backoff, unless the deadline has passed, in which case the sweeper takes over. **Unsigned passes at close time aren't paid.** That's the seller's capped risk, and the dashboard shows it ("1 call delivered without a receipt").
- **`ChannelSweeper`** (every 60 s): `status in ('locked','closing')` and `close_deadline + 1 min < now` → `buildReclaimTx` → `reclaimed`. Also expires `quoted` rows past `quote_expires_at` → `quote_expired`.
- Revoke the bearer token when a channel leaves `locked`.
- **Routes:**
  - `POST /a/:apiId/channels/:channelId/receipt` `{ accepted, signature }` → same rules as the header; 200 `{ receiptAccepted }`.
  - `POST /a/:apiId/channels/:channelId/close` (Bearer token of that channel) → 202 `{ status: "closing" }`.
  - `GET /a/:apiId/channels/:channelId` → `{ status, maxCalls, passesServed, receiptAccepted, closeDeadline, lockTx, closeTx, sellerPaid, feePaid, buyerRefund, buyerCloseFee }`. Public; it holds no secrets. Judges can open it.
- **Operator wallet:** new env `OPERATOR_MNEMONIC` (preprod, ≥ 30 tADA, split into 5 UTxOs so collateral and fee inputs never collide). `/internal/apis/:apiId/health` gains `operatorLovelace` so low funds show up before the demo.

- [ ] **Failing tests** with a fake chain: close at max_calls, close on request, close at deadline margin with `accepted = receipt_accepted` (not `passes_served`), one closer wins a race, sweeper reclaims after the deadline, an expired quote is marked, the token is revoked after close.
- [ ] Implement → green → **hour-19 gate run on preprod** (below) → commit.

**Hour-19 gate (07:00 Wed), run by P6 with P1 watching:**
1. `PACK_MODE=escrow DEMO_MODE=1` gateway on EC2.
2. Buyer script: buy pack (x402) → Cardanoscan shows tUSDM at the escrow address with the datum.
3. 3 calls pass, with receipts 1, 2, 3; then flip the price API break switch; 2 calls → 422 and no new receipt.
4. `POST …/close` → close tx: seller +0.06 tUSDM, buyer +1.94 tUSDM and the locked ADA back.
5. `GET /a/:apiId/channels/:id` shows `closed` and both payouts.
**Pass →** escrow packs are the demo path. **Fail →** `PACK_MODE=direct` for the live system; keep the Task 4 Cardanoscan links and a screen recording of the hand-run close for the "where we're going" beat.

---

### Task 8: Buyer agent — receipt keys, local promise check, signing (hour 19–20.5, pair with P5)

**Files:** `agents/buyer/src/receipts.ts`, `agents/buyer/src/escrowPackFlow.ts`, tests; modify the pack-buyer CLI

- Per pack: `newReceiptKey()`; store `{ channelId, secretKey, apiId, lastSigned }` in the buyer's token store (`agents/buyer/.state/`, `chmod 600`, git-ignored).
- Buying: send `X-Hirakumi-Receipt-Key` and `X-Hirakumi-Refund-Address` (the buyer wallet address) on **both** the unpaid and the paid request. Before paying, decode `extra.datum` from the 402 and check: the receipt key is ours, the refund address is ours, price per call × calls = amount, `closeDeadline` is in the future, `payTo` = the known `PACK_ESCROW.address`, `assetTransferMethod = "script"`, `feeBps` / `unsignedAllowance` in the datum and offer equal what the 402 body advertised, `closeFeeBudget ≤ 1 000 000` lovelace, and the safety deadline is no more than 365 days away. The buyer can also cap the allowance it accepts (`--max-allowance`, default 10). **Refuse to pay** if any check fails. This is the buyer's protection against a malicious gateway sending a datum that pays someone else.
- Each call: attach the latest receipt. On 200 with `X-Hirakumi-Sign-Next: n`: fetch the rule once from `/r/:ruleHash` (cache it), run `compileRule` from `@hirakumi/core` on the response body, and sign `n` **only if the local check passes**. If the gateway says pass but the local check says fail: don't sign, stop calling, log "promise dispute", and request close. The seller is not paid for that call.
- On 402 `receipt_required`: sign `signNext` if it was earned (≤ passes we saw) and retry once.
- `close` command: `POST …/close`, then poll `GET …/channels/:id` until `closed`, and print both payouts with Cardanoscan links.
- Tests: refuses to pay a 402 whose datum has a different refund address; never signs above the number of locally-verified passes; signs exactly once per pass; a gateway-pass/local-fail response stops the flow; resumes with the stored key after a restart.

---

### Task 9: Dashboard rows (P2, hour 20.5–21, optional)

On the API overview and Sales screens, add an **Escrow packs** table: buyer (short address), status pill (`Locked`, `Closing`, `Closed`, `Refunded`), calls passed / paid / max, seller paid, Hirakumi fee, buyer refunded, the seller's allowance, lock and close Cardanoscan links. Read from `pack_channels` (read-only for web). Plain words: "Paid out on close", "Returned to buyer". Cut first if time is short; the CLI output and Cardanoscan are enough for the video.

---

### Task 10: Demo, pitch and write-up changes (P5 + P6, hour 21–22)

- **Pitch line:** "Buyers only pay for responses that pass, and Cardano enforces it, not us."
- **Demo beats** (replaces 1:20–2:25 in the spec):
  - **1:20** The agent buys a pack: one x402 payment. Cardanoscan shows the money **locked at the escrow address**, not at the seller.
  - **1:40** Calls: pass, pass, pass, each with the buyer's signed receipt counter going 1 → 2 → 3 on screen.
  - **1:55** Break switch: 422, no receipt signed; Down; Sokosumi alert (time-cut).
  - **2:20** Close: one transaction, **seller 3 calls, buyer 97 back**. Show both outputs on Cardanoscan.
  - **2:35** One line on Masumi escrow jobs (pre-recorded), then the vision.
- **Slide:** the "who you trust for what" table, now with packs moved to the chain column for money and payout count.
- **Write-up:** state precisely what is enforced on-chain (payout ≤ the buyer's signed count; refunds go only to the buyer; anyone can reclaim after the deadline) and what isn't (the gateway decides whether to serve; seller risk = the allowance the seller chose; the pass check is a schema-and-freshness promise, not truth). Link the validator file and its tests.
- **Explainer page:** update the "Who keeps the promise?" artifact to show the new design.

---

## Edge cases (and what happens)

| Case | Result |
|---|---|
| Buyer stops signing after a pass | Next call → 402 `receipt_required`. Seller loses ≤ their chosen allowance of calls. The close pays what was signed. |
| Seller sets the allowance to the full pack | Allowed. The buyer can then use the whole pack and sign nothing; the seller has chosen to trust buyers. The pricing screen warns about this. |
| Tiny prices round the fee to 0 | Allowed (floor). With 20 000 micros per call the fee is 600 micros per call, so this never happens at the demo price. |
| Gateway says pass, buyer's local check says fail | Buyer doesn't sign and asks to close. The seller isn't paid for that call. Logged on both sides as a dispute. |
| Hirakumi gateway goes down for good | The buyer can't close early (that needs Hirakumi's key, to protect the seller). They reclaim 100% of the tokens after the safety deadline, so the seller loses the signed passes. Mitigation for production: let the seller co-sign closes too, and share receipts with the seller (roadmap). |
| Buyer tries to close with an old, lower receipt | Rejected on-chain: no operator signature. |
| Buyer never says "done" and stops calling | The pack stays open until 1 day before the safety deadline, then Hirakumi closes with the latest receipt. The seller waits up to 90 days for that money; sellers who mind can choose a shorter lifetime. |
| Someone submits a reclaim with an inflated fee | They burn up to 0.7 ADA of the buyer's locked ADA as network fee and gain nothing. Capped by `close_fee_budget`. |
| Seller API goes down for good | No more passes. The buyer says "done" (or the close at the safety deadline) pays the seller for signed passes and returns the rest. This fixes the "prepaid credits are lost" edge case in spec §11. |
| Close tx fails (operator out of ADA, Blockfrost down) | Retries with backoff; if the deadline passes, the sweeper reclaims to the buyer and the **seller loses the signed passes**. Mitigation: operator balance shown in health and checked in the demo checklist; close margin 1 day in production. |
| Buyer pays twice for the same quote (two lock txs) | The second lock is recorded only by the reconciler (unknown outref) → swept back to the buyer after the deadline. The receipt is valid for both UTxOs, but the validator allows only one script input per tx, and the gateway closes only the recorded outref. A dishonest *seller* can't use the receipt: it's stored only in Hirakumi's DB. Documented, not fixed. |
| Someone sends extra tokens to the channel UTxO | They go to the buyer on close or reclaim. |
| Someone sends a junk UTxO with a fake datum to the escrow address | The gateway ignores outrefs it didn't record. Nothing can be stolen from real channels. |
| Clock skew near the deadline | Calls stop 2 minutes before the deadline; the close uses `invalidHereafter ≤ deadline − 1 min`; the reclaim uses `invalidBefore ≥ deadline + 1 min`. |
| Receipt replay on another channel | Impossible: the message includes the 32-byte `channel_id`. |
| Price change by the seller | Existing channels keep their datum price. |
| Rule change by the seller | Rules are frozen once Live (spec §11). `rule_hash` is in the datum, so the promise bought is on-chain. |

## Costs per pack (preprod, from spike numbers; fill in after S1/S2)

| Who | Pays | Approx. |
|---|---|---|
| Buyer | Lock tx fee + close network fee (from locked ADA; the rest of the ~2 ADA is returned) | ~0.2 + ~0.5 ADA |
| Hirakumi operator | Min-ADA for the seller's payout (the fee payout's min-ADA comes back to itself) | ~1.2 ADA net per close |
| Seller | Nothing | Receives tokens + ~1.2 ADA |

Compare: the direct pack costs the buyer ~1.4 ADA of overhead. The escrow pack costs the buyer ~0.7 ADA and Hirakumi ~1.2 ADA. Hirakumi's 3% fee on a 2 tUSDM pack (≤ 0.06 tUSDM) doesn't cover 1.2 ADA, so small packs lose Hirakumi money until pack sizes grow or the onboarding fee covers it. Say this plainly if a judge asks about unit economics.

---

## Contract v1.2 amendments (proposed — P1, P2, P5 confirm in chat)

- **E1.** New env: `PACK_MODE=escrow|direct` (default `direct` until the hour-19 gate passes), `OPERATOR_MNEMONIC`, `HIRAKUMI_FEE_ADDRESS`, `HIRAKUMI_FEE_BPS=300`, `CLOSE_FEE_BUDGET_LOVELACE=700000`, `CLOSE_MARGIN_SECONDS` (86400; demo 180). The lifetime comes from `packs.lifetime_days`; `DEMO_MODE=1` forces 20 minutes.
- **E2.** New package `@hirakumi/escrow` (owner P6). New migration `0004_pack_channels.sql` (owner P6, reviewed by P1). Gateway writes `pack_channels`; web reads it.
- **E3.** Escrow-mode pack route needs headers `X-Hirakumi-Receipt-Key` and `X-Hirakumi-Refund-Address`; 400 `receipt_key_required` / `bad_refund_address`. The 200 body adds `channelId`, `closeDeadline`, `escrowAddress`.
- **E4.** Paid call responses add `X-Hirakumi-Sign-Next` on 200. New errors: 402 `receipt_required` `{ signNext, channelId }`, 401 `bad_receipt`, 401 `receipt_ahead`, 409 `channel_closing`.
- **E5.** New routes: `POST /a/:apiId/channels/:channelId/receipt`, `POST /a/:apiId/channels/:channelId/close`, `GET /a/:apiId/channels/:channelId`.
- **E6.** In escrow mode the pack price must divide exactly by the number of calls (web validation).
- **E7.** The 402 `credits_required` body on `/x/:opId` adds `mode: "escrow" | "direct"`, `unsignedAllowance` and `feeBps` per pack, so buyers know which flow to use and what they're agreeing to.
- **E8.** `packs.unsigned_allowance` (int, default 1, `1…calls`) is written by **web** on the pricing screen. Copy: "How many good answers can a buyer receive before they confirm them? 1 is safest for you. Higher is faster for buyers, but you may not be paid for that many calls if a buyer stops confirming."
- **E10.** `packs.lifetime_days` (int, default 90, 1–365) is written by **web** on the pricing screen. Copy: "Packs stay open until the buyer is done. If a buyer goes quiet, you're paid for confirmed calls this many days after purchase."
- **E9.** The pricing screen shows the split: "Buyer pays 0.02 per good answer. You receive 0.0194; Hirakumi keeps 0.0006 (3%). Failed answers cost the buyer nothing."

## Self-Review

- Every behaviour in "How it works" maps to a task: lock (T5), gate (T6), close and sweep (T7), buyer checks (T8), validator rules (T2).
- Every Review Focus item has a named test.
- The first two hours are spent proving the two riskiest assumptions (S1 x402 script lock, S2 V3 spend) before anything is built on them, with a named fallback for each.
- Direct packs remain untouched behind `PACK_MODE=direct`, so a failed gate costs no demo.
