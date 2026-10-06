# Experimental: hybrid settlement, proofs on chain, live ticker, CRE

Branch: `exp/escrow-proofs`. Nothing merges to `main` until it passes the full suite, the stress suite and one real preprod run.
Deadline 7 Oct 23:59 SGT. Feature freeze 17:00. Video and slides 17:00 to 21:00. Submit by 22:00.

## 3. Hybrid settlement (`PACK_MODE=hybrid`)

Problem: `direct` is fast and cheap but the buyer trusts the seller. `escrow` is trustless but costs a lock, a close and a settle tx.
No single mode is right for every pack. A policy picks per purchase, and says why.

**Policy, pure function** in `packages/core/src/settlement.ts`:

```
chooseSettlement({ priceMicros, sellerUptime7d, listingAgeDays, buyerCanEscrow }) -> { mode, reasons[] }
```

| Condition | Mode |
|---|---|
| Buyer did not send a receipt key and refund address | direct (escrow impossible) |
| Pack price >= 2 tUSDM | escrow |
| Seller uptime over 7 days < 99% | escrow |
| Listing younger than 7 days | escrow |
| Otherwise | direct |

Thresholds live in config. Reasons are plain strings shown to buyers and judges ("new seller", "large pack").

**Gateway** (`apps/gateway/src/packs.ts`, `config.ts`):
- `PACK_MODE` accepts `hybrid`. `escrowMode(d)` becomes `modeFor(d, ctx)`, which calls the policy with the API's health and the request headers.
- The 402 `extra` carries `settlement: { mode, reasons }`, so a buyer sees the decision before paying.
- Uptime comes from `health_events` (already recorded by `monitor.ts`). One query, cached 60 s per API.

**Buyer** (`agents/buyer`): always sends escrow headers; it follows `extra.settlement.mode` and still runs `checkEscrowOffer` before it pays. It refuses direct above its own cap (default 5 tUSDM).

**Try it live** (`demoBuy.ts`): goes through the same policy. Escrow buys need an IOU key on EC2, generated per try and stored with `try_tokens`.

**Web**: the API page shows "Settlement: escrow, because: new seller". Pack table shows the mode per pack.

**Tests**: policy table tests; gateway 402 shape for each mode; hybrid falls back to direct without buyer keys; full stress suite in hybrid.
**Live check**: one direct buy and one escrow buy (lock, calls, close, settle) on preprod, tx hashes into `submission-checklist.md`.
**Risk**: escrow needs Blockfrost and the operator key on EC2 (both present). If the live escrow run fails, ship with `PACK_MODE=direct` and the policy visible as "recommended".
**Estimate**: 4 to 5 h.

## 4. Proof of kept promises on chain

Problem: status pages and charges are our word. Make them checkable.

- Migration 0011: `proof_batches(id, from_call_id, to_call_id, root, leaf_count, tx_hash, anchored_at)`.
- Leaf per call: `sha256(call_id | api_id | op | status | kept | charged | ts_minute)`. Buyer identity only as a hashed token id.
- Anchor worker in the gateway: every 10 min, if new calls exist, build a sha256 Merkle tree and post the root in tx metadata (label 2049, CIP-20 style) from the operator wallet. About 0.18 tADA per anchor.
- Every paid response carries `X-Hirakumi-Receipt: <leaf hash>`. Once anchored, the buyer can fetch an inclusion proof. That is dispute evidence for Masumi.
- Endpoints: `GET /proofs/latest`, `GET /proofs/:batchId` (leaves), `GET /proofs/call/:callId` (path to root).
- Status page: "Last anchored 4 min ago, tx …". A Verify button recomputes the root in the browser and compares it with the metadata fetched from Blockfrost.

**Tests**: Merkle tree and proof vectors; batch boundaries (no gaps, no double count); worker skips when idle; metadata size limit (64 bytes per string, root is 32).
**Estimate**: 3 to 4 h.

## 5. Live tx ticker

- `GET /api/live` on web: SSE, polls Neon every 3 s for settled packs, escrow closes and proof anchors. Each row links Cardanoscan preprod and shows seconds from request to block.
- Landing strip under the hero, plus `/live`. Empty state is honest: "Quiet right now. Last tx 12 min ago."
- No synthetic events, ever.

**Tests**: SSE route returns only real rows; empty state; reconnect.
**Estimate**: 1.5 to 2 h.

## 7. Chainlink CRE (only if a Chainlink prize applies)

The Cardano rubric does not score it, and it can dilute the Cardano story.
If done: a CRE workflow reads the latest proof root (item 4) and writes an attestation on Base Sepolia, so proofs are mirrored cross-chain.
Needs from the user: `cre login`, Base Sepolia ETH. Estimate 4 to 6 h. Start only after 3, 4 and 5 are merged.

## Order

1. 4 and 5 in parallel (independent of packs code).
2. 3 after that, because it touches the purchase path; it gets the longest test pass.
3. 7 only on a yes and only with time left.
4. Merge, deploy EC2 then Vercel, stress, record video.
