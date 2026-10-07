# Hirakumi: make your APIs monetizable for AI agents

## Problem
AI agents buy data per call, but most useful data sits behind ordinary HTTP APIs whose owners have no way to sell to them. To sell on Masumi today an API owner must build and register an agent, handle Cardano payments and run an honest health endpoint. Buyers carry the risk: they pay even when an answer is empty or stale. And paying per call on chain does not work on Cardano: every payment output needs about 1.2 to 1.5 ADA of min-UTxO plus about 0.17 ADA in fees, and waits for a block.

## What we built
Hirakumi takes any read-only API to the agent market. The seller gives an OpenAPI link, or just a base URL and a few example requests, chooses endpoints, proves ownership with a response header and one wallet signature, and approves a price and a promise that every good answer must keep. The listing becomes a Masumi-registered agent with a monitored health status. Buyer agents pay once for a pack of calls with x402, and a call uses a credit only when its answer passes the promise. Per purchase, Hirakumi settles the pack direct to the seller or through an Aiken escrow contract that pays the seller only for calls the buyer signed for; a buyer can always demand escrow. Onboarding runs on the website or from a Sokosumi task assigned to the Hirakumi coworker.

## Technical approach

### Cardano and x402
- **Packs over x402** (`@x402/*` 2.26.0, `cardano:preprod`, hosted preprod facilitator): each API gets an x402-protected pack route (`exact` scheme, tUSDM). The credit token is created pending and activated only in `onAfterSettle`, so an unsettled payment can never be used. One payment covers 100 calls: about 0.014 ADA of overhead per call instead of about 1.4 ADA.
- **Credits only on pass:** a paid call atomically reserves one credit (`UPDATE ... WHERE remaining > 0 RETURNING`), calls the seller through an SSRF-safe fetch, and checks the answer. Pass: commit and 200. Fail: release and 422 with the failing checks. The rule's hash is in the 402 before payment and the rule is public at `/r/<ruleHash>`.
- **Hybrid settlement** (`PACK_MODE=hybrid`, the default): a pure policy picks escrow for a pack of 2 tUSDM or more, a seller under 99% uptime over 7 days, a listing younger than 7 days, or a buyer that sends `X-Hirakumi-Settlement: escrow`; direct otherwise. The 402 carries the mode and the reasons in `extra.settlement`. A buyer that demands escrow gets escrow or a 503, never a silent direct offer.
- **Pack escrow contract** (`contracts/pack-escrow`, Aiken, Plutus V3, 175 tests): the x402 payment locks the pack at the validator with an inline datum (buyer refund address, seller, price per call, IOU key, closer, contest period, fee). The buyer agent checks every answer itself and signs a cumulative ed25519 IOU over `"HKR1" || channel_id || count` only for passes. `Close` proposes a count (0 needs no signature, so the buyer can always exit), `Raise` lets anyone with a higher signed IOU raise it during the contest window, and `Settle` pays the seller `count x price - fee`, Hirakumi a 3% fee and the buyer the rest, with payouts summed per address so one output cannot satisfy two payouts. The gateway verifies each lock on chain (Blockfrost), gates paid calls on the buyer's IOUs, publishes the latest IOU on a public channel page, and runs a watcher that raises stale closes and settles. Off-chain code uses the Evolution SDK (`packages/escrow`).

### Masumi and Sokosumi
- **Registry:** each published API is registered through our self-hosted Masumi payment service (0.29) and gets a registry token on preprod.
- **MIP-003 and MIP-004:** `start_job`, `status`, `availability` and `input_schema` per API, with MIP-004 input and output hashes. A Masumi escrow job whose answer fails the promise is never submitted, so Masumi refunds the buyer automatically.
- **Truthful availability:** a monitor re-runs the saved test inputs against the full promise. After repeated failures `/availability` answers 503 (the registry shows the agent Offline), paid routes answer 503 before payment, and the seller gets a comment on their Sokosumi task.
- **Sokosumi coworker:** an onboarding state machine that reads the API, describes endpoints with one structured LLM call (OpenAI `responses.parse`, or Anthropic), runs test calls, registers the agent, and posts each step as a task comment. Steps that need the seller's wallet (sign in, prove ownership, publish) get one deep link to that web step. The buyer-facing promise text is generated from the rule itself, never by the model.

### Any API, safely
- **Example requests instead of an OpenAPI file:** lines such as `GET /coins/{id=cardano}?days?=7` or `POST /search {"q":"ada"}` become an OpenAPI 3.1 document, so the rest of onboarding is the same.
- **Ownership by response header:** the API sends a per-API code in `X-Hirakumi-Verify` at its base URL; the gateway checks it with one plain `GET`, no redirects followed. The ownership page reads the API's own response headers to detect its platform (Express, Next.js, FastAPI, Flask, Vercel, Netlify, Cloudflare, nginx) and preselects the matching snippet, or gives a ready prompt under "Let your AI do it" for a coding assistant. A CIP-30 signature binds the payout address. The header is checked again every 6 hours; two misses in a row pause new sales, and credits already sold keep working.
- **Text promises:** CSV, XML, plain text and YAML answers are checked for a 2xx status, the media type, a non-empty body, no HTML error page, and a required phrase. Hirakumi suggests a phrase from the test calls (one every good answer has and a wrong request's answer lacks), and the seller must confirm one before publishing.
- **Seller API keys:** sealed in the web app with the gateway's X25519 public key and bound to the API's id, origin, path and placement. Only the gateway can open a key, adds it only to calls inside the proven origin and folder, and withholds any answer that contains it.

### Stack
TypeScript throughout: Express gateway, Next.js web app, Node coworker, Postgres (Neon) with plain SQL migrations, Vitest (about 1,770 tests across workspaces), Aiken for the validator, Docker Compose and Caddy on AWS EC2, Vercel for the web app.

## Measured on preprod
- x402 packs settled in 16.5 s and 9.4 s, paid straight to the seller; paid calls through the gateway returned in about 0.3 s.
- Hybrid on the production gateway with the buyer demanding escrow: lock, 3 calls checked locally and signed, Close at 3, Settle paying the seller 0.0582, Hirakumi 0.0018 and the buyer back 1.94 tUSDM (Settle `cad54fc0...`).
- Escrow Close at 1, Raise to 3, Settle; a buyer exit with no IOU returned everything. Close, Raise and Settle each cost about 0.35 to 0.43 ADA in fees with the script inline.
- A Masumi escrow job that kept its promise was locked, answered, verified and collected; one with stale data was refused, nothing was submitted, and Masumi refunded it.

All transaction hashes are in `docs/submission/submission-checklist.md`.

## Who you trust
- **Escrow pack:** the money sits in the contract. The seller is paid only for calls the buyer signed for, and the buyer can always exit with everything unsigned. If Hirakumi closes with an old count, anyone holding the buyer's higher IOU (published on the channel page) can raise it.
- **Direct pack:** the money goes to the seller at purchase and the gateway counts credits, using one only on a pass. Receipts make every call auditable, but the chain does not refund a wrong charge.
- **Masumi escrow job:** Masumi's contract holds the money per job and refunds if no passing result is submitted.

## Deployment and scaling
- **Today:** one AWS EC2 instance (us-east-1) running Docker Compose: the gateway, the coworker, the Masumi payment service with its Postgres, Caddy for HTTPS, and the two demo seller APIs. Hirakumi's data is in Neon Postgres; the web app is on Vercel.
- **Scaling:** a paid call is one indexed lookup and one atomic update, with nothing on chain per call, so throughput is Postgres throughput. The gateway keeps no per-call state outside Postgres except health counters; moving those to Postgres or Redis lets it run as several instances behind Caddy. One payment-service node serves many sellers.
- **Path to production:** a reference-script UTxO for the validator (cuts each spend's fee), mainnet USDM, a contract audit, and escrow as the default for new sellers. Revenue: the 3% fee (already an output of the escrow contract) and an onboarding fee in Sokosumi credits.

## Links
- Repo: https://github.com/frederickemerson/hirakumi
- Web app: https://hirakumi.vercel.app
- Gateway: https://52-70-235-103.sslip.io
- Demo sellers: https://price.52-70-235-103.sslip.io, https://mika.52-70-235-103.sslip.io
- Video and slides: see `docs/submission/submission-checklist.md`
