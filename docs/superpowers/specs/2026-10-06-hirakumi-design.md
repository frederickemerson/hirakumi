# Hirakumi: design spec (v4)

**Date:** 6 Oct 2026. **Event:** TOKEN2049 Origins hackathon, Cardano "Agentic Commerce" track. **Deadline:** 7 Oct 2026, 23:59 SGT.
**Status:** v4. This version applies the audit cuts and adds a speed design. Interactive version: https://claude.ai/artifact/RhSWtpvxDJ5jskipiWpPBS

## 1. Product

Hirakumi (開く *hiraku*, "to open") is a Sokosumi coworker that takes any read-only OpenAPI API to market in the Masumi agent economy.

- **Seller:** hands over an OpenAPI URL, confirms endpoints, proves ownership, approves a price and a promise. The result is a Masumi-registered agent with a monitored health status.
- **Buyer agents:** discover the API on the Masumi registry. They either buy a **call pack** with one x402 payment on Cardano preprod, or hire it per job through **Masumi escrow**.
- **Core rule:** a buyer's credit or escrowed funds are consumed **only when the response passes the published promise** (an acceptance rule).
- **Monitoring:** keeps Masumi's existing Online/Offline status truthful.

**Pitch:** "Hirakumi turns any API into a paid supplier for AI agents in three minutes, and buyers only pay for responses that pass."

### What Hirakumi adds to Masumi

| Masumi already has | Hirakumi adds |
|---|---|
| NFT registry | One-step registration from an OpenAPI spec |
| Registry health check: `/availability` must return 200, otherwise the agent is marked Offline | `/availability` answers from real test calls: 200 when healthy, 503 when down |
| Escrow with automatic refund if no result arrives before `submitResultTime` | An acceptance rule decides whether a result is submitted |
| MIP-004 input/output hashes | Rule hash published before purchase |
| Sokosumi coworkers (tasks, events, usage) | The onboarding coworker itself, plus health alerts on the seller's task |

## 2. Users and stories

People:
- **Mika**, an API seller with no Cardano experience.
- **Dev**, an agent builder who needs data per call.
- **Sora**, a Sokosumi user hiring with credits.
- **Operator**, which is us.

| # | Story | Accepted when |
|---|---|---|
| US1 | Seller hands the OpenAPI link to the coworker and answers a few questions | Spec to Live in under 5 minutes with 4 seller actions: confirm endpoints, serve the challenge file, sign, approve |
| US2 | Seller proves ownership once | A listing can never go Live without a served challenge file and a wallet signature |
| US3 | Seller sees a suggested pack price and a plain-English promise | The rule is shown as sentences with the JSON underneath; the price can be overridden |
| US4 | Seller learns immediately when the API breaks | Demo mode: within 30s the dashboard shows Down and a Sokosumi comment appears; the registry shows Offline on its next check |
| US5 | Seller sees earnings with transaction links | The dashboard lists pack sales and escrow jobs with Cardanoscan links |
| US6 | Agent builder finds the API on the registry and integrates it with a standard x402 client | Under 20 lines with `@x402/fetch`; the 402 shows pack price, rule hash and rule URL |
| US7 | Agent builder never spends a credit on a broken response | A failing response returns 422 and the credit balance is unchanged |
| US8 | Agent builder skips down APIs | A down API answers 503 before any payment or credit use |
| US9 | Sokosumi user hires per job and is refunded on failure | Pass: result submitted. Fail: no result, and Masumi refunds automatically after `submitResultTime`. |

## 3. User flows

1. **Mika lists her API.**
   1. Sokosumi task "Put my API on the agent market"; the coworker sends a setup link.
   2. Mika pastes the OpenAPI URL. The coworker comments "found 6 endpoints, 2 look sellable".
   3. Mika ticks the endpoints and confirms they have no side effects.
   4. She downloads the challenge file, uploads it to her server, and clicks Check. On failure the page shows the exact URL tried and the error.
   5. She connects Eternl and signs one message, shown in plain words.
   6. Test calls run with live progress.
   7. On the review page she sees the promise in plain English and a pack price suggestion, then clicks Publish.
   8. Registration takes about 1 minute. Then she sees Live: agent ID, URLs, an Online badge and a buyer snippet.
2. **Dev's agent buys calls.**
   1. Searches the registry for agents that are Online.
   2. `GET` the operation. It gets back:
      - 503 if the API is down, with no payment asked;
      - 400 if the input is bad, with no payment asked;
      - 402 if it has no credits.
   3. Checks the spend cap, then pays for a pack: `POST /packs/:packId` with x402, one confirmation.
   4. Receives a credit token.
   5. Calls with `Authorization: Bearer`. A pass returns 200 and uses 1 credit. A fail returns 422 and uses nothing.
3. **Sora hires on Sokosumi.**
   1. Picks the agent and fills the input form.
   2. Funds are locked in escrow and the job runs.
   3. Pass: result shown. Fail: "what failed", and the refund is automatic after `submitResultTime`.
4. **Mika's API breaks.**
   1. The deploy returns `{}`.
   2. Paid calls return 422, so no credits are used.
   3. The monitor fails 2 probes (demo mode, 10s interval). `/availability` returns 503 and the x402 route returns 503.
   4. The coworker comments on Mika's task with the failing field and the time of the first failure. The registry marks Offline on its next check.
   5. Mika fixes it. After 2 passing probes the API is Live again.
   6. The dashboard shows the downtime, "0 credits consumed" and the number of calls refused.

**Screens:** Setup, Endpoints, Ownership, Review, API overview (health, calls, pass rate, earnings, buyer snippet), Sales. Each has a plain-language empty state and error state.

## 4. Architecture

| Component | Purpose | Host |
|---|---|---|
| `apps/gateway` | Express server. For each API it serves pack sales via x402, credit-gated proxy calls, MIP-003 endpoints (`start_job`, `status`, `availability`, `input_schema`), rule checks, evidence logging and the in-process monitor | AWS EC2 (ap-southeast-1) |
| `masumi-payment-service` | Official Masumi node (Docker): registry registration, escrow payment requests, result submission. Also acts as the demo escrow buyer, with a separate purchasing wallet. | AWS EC2 |
| Postgres | One shared database | AWS EC2 |
| Caddy | Automatic HTTPS for the public wrapper domain, which the registry requires | AWS EC2 |
| `apps/coworker` | Sokosumi coworker: task events, onboarding state machine, one LLM step. Runs in a dashboard chat if Sokosumi whitelisting isn't granted by hour 2. | AWS EC2 |
| `apps/web` | Next.js dashboard and signing pages; public API page with the buyer snippet | Vercel |
| `packages/core` | Shared types, rule engine (ajv plus a `maxAgeSeconds` keyword), MIP-004 hashing (JCS), SSRF-safe fetch, challenge message format | Library |
| `sellers/price-api` | Demo seller: `GET /price?symbol=ADA` with an OpenAPI spec and a break switch (`{}` mode and stale mode) | Vercel |
| `agents/buyer` | Demo x402 pack buyer and caller, and a demo escrow buyer | Local |
| `cre/scorer` | Stretch, gated at hour 18: CRE workflow run in simulation that probes and writes a score to Base Sepolia | Local |

Deployment: one EC2 instance with Docker Compose (gateway, coworker, payment service, Postgres, Caddy), plus Vercel for the web app and the demo seller. Masumi doesn't host coworkers (the developer runs the worker), and Hermes can't run custom code.

## 5. Onboarding (coworker)

Everything is deterministic code except one LLM step. Each step's state is saved and safe to re-run.

1. **Intake:** OpenAPI URL. The demo API is public; upstream auth is out of scope.
2. **Parse (code):** parse OpenAPI 3.x and list the operations. Everything is blocked by default.
3. **Describe (the only LLM step, Claude, structured output):**
   - an agent-friendly description per operation,
   - a likely-side-effects flag,
   - later, the plain-English version of the rule and the Sokosumi listing text.
   - Spec text is passed as quoted data. The LLM has no tools.
4. **Seller confirms endpoints.** Non-GET operations need an explicit "no side effects" tick. The seller also picks the one **escrow operation** used for MIP-003 jobs.
5. **Ownership:** an HTTP challenge file at `/.well-known/hirakumi/<apiId>.txt` (single use, expires after 30 minutes), plus a CIP-30 `signData` over: domain, sellerId, apiId, origin, payTo, nonce, expiry, `cardano:preprod`. Verified with `checkSignature`.
6. **QA (code):**
   - Run the OpenAPI examples plus the seller's sample input, at least 5 calls, in parallel.
   - The rule requires fields present in every passing sample, with their observed types.
   - Add `maxAgeSeconds` if a timestamp field is detected.
   - Send one bad-input call; the rule must reject the error shape.
   - Save the test inputs for the monitor.
7. **Price:** the seller sets the pack size and price. The suggested default is 100 calls for 2 tUSDM. Escrow price per job is set the same way.
8. **Publish:**
   - Register on the Masumi registry through our payment node (`POST /registry`), with `apiBaseUrl` set to `https://<domain>/a/<apiId>`. The platform purchasing wallet pays the mint fee of about 2 ADA plus the min-lovelace held with the NFT.
   - Wait for Online.
   - Generate the Sokosumi listing package for the seller to submit (Tally form, reviewed by Masumi).

## 6. Payment paths

### 6.1 Call packs over x402 (main path)

Paying for every call on-chain is uneconomic on Cardano: each payment carries about 1.2–1.5 ADA min-UTxO plus about 0.17 ADA in fees, and waits for confirmation. One payment therefore buys a pack of calls.

1. `GET|POST /a/:apiId/x/:opId` without a valid credit token:
   - 400 if the input is invalid,
   - 503 if the API is down,
   - otherwise 402 pointing to the pack offer.
2. `POST /a/:apiId/packs/:packId` is an x402-protected route:
   - **`payTo` = the seller's verified address** (non-custodial),
   - asset tUSDM,
   - `extra: {apiId, packId, calls, ruleHash, ruleUrl}`.
3. Settlement timing: the handler creates a credit token in **pending** state and returns it. The middleware settles only after the handler finishes. An `onAfterSettle` hook activates the token, and `onSettleFailure` leaves it pending, so it can never be used. A token is only usable once payment has settled.
4. A paid call with `Authorization: Bearer <token>`:
   - Look up the token by hash.
   - Atomically reserve 1 credit: `UPDATE … SET remaining = remaining - 1 WHERE remaining > 0 RETURNING`.
   - Proxy upstream, then check the rule.
   - **Pass:** commit, return 200 with the `X-Credits-Remaining` header.
   - **Fail or upstream error:** release the credit, return 422, 502 or 504 with the failed rule paths.
5. Evidence row per call: input hash, output hash (MIP-004 style, keyed by token ID), rule version, verdict, latency.

### 6.2 Escrow jobs (MIP-003)

1. `POST /a/:apiId/start_job` with `{input_data, identifier_from_purchaser}`. The wrapper creates a payment request on our payment node, with a short demo `submitResultTime`.
2. The buyer locks funds. The wrapper polls until `FundsLocked`, then calls upstream and checks the rule.
3. **Pass:** submit the result hash (`submitResultHash`); the funds unlock to the seller's collection after `unlockTime`. Masumi takes 5%.
4. **Fail:** **submit no result.** `/status` returns `failed` with the failing rule paths, and Masumi refunds automatically once `submitResultTime` passes. Masumi's docs confirm this auto-refund trigger. `AuthorizeRefund` is only valid after the buyer requests a refund, so we don't use it.
5. To verify in the spike: whether collection can go straight to the seller's address. If not, escrow earnings arrive at the platform collection wallet and are swept to the seller manually for the demo, and the dashboard says so.

## 7. Monitoring

- **Probes:** in-process in the gateway. Production mode probes every 120s; demo mode every 10s. Each probe uses saved test inputs and checks the full rule.
- **States:** Healthy, or Down.
  - 3 consecutive failures (2 in demo mode) → Down.
  - 2 consecutive passes → Healthy.
- **Truthful `/availability`:** 200 `{status:"available"}` when Healthy, **503** `{status:"unavailable", estimated_downtime_seconds}` when Down. The Masumi registry marks an agent Offline when `/availability` isn't a 200. The x402 route and `start_job` also return 503 when Down.
- **Alerts:** when the state changes, the coworker comments on the seller's Sokosumi task (dashboard chat as fallback), naming the failing field and when the failures started.
- Stretch: a CRE score workflow, described honestly as a workflow run in simulation.

## 8. Speed

### Response time for buyer agents

| Operation | Target | How |
|---|---|---|
| Credit-backed call (the common path) | Our added time under 50ms p50; total = upstream time + 50ms | Token looked up by an indexed hash; one atomic `UPDATE … RETURNING` for the credit; ajv validators compiled once per rule version and cached; keep-alive pooled upstream connections (undici); gateway and Postgres on the same EC2 instance in ap-southeast-1; no on-chain step per call |
| 400 / 402 / 503 rejections | Under 20ms | Rejected before any upstream or chain call; health state kept in memory |
| Pack purchase | One block confirmation, about 20s on preprod | `l1Confirmations: 0` (block inclusion). The hosted facilitator's minimum is 0, so mempool acceptance (−1) isn't available. Happens once per 100 calls. |
| Escrow job | Minutes, which is how Masumi escrow works | Short `submitResultTime` and `unlockTime` for the demo; this part of the video is pre-recorded |
| `/availability` | Under 10ms | Served from memory; never calls upstream |

### Onboarding speed (target under 3 minutes of machine time)

- QA test calls run in parallel.
- A single LLM call with structured output covers all descriptions.
- Registry registration runs in the background straight after Publish, with live progress.
- Listing text is generated while registration confirms.

### Build speed

Reuse instead of writing:
- `x402-express` template (seller, buyer, local facilitator),
- `x402-cardano-demo` (Masumi registration script, hashing),
- the official Masumi payment-service Docker setup,
- `pi-sokosumi` (coworker client and task poller),
- shadcn/ui for the dashboard.

One gateway process holds the wrappers, MIP-003 endpoints and the monitor. Deterministic code comes before any LLM, so the product works end to end without the coworker by hour 10.

## 9. Monetization

Non-custodial for x402: pack payments go straight to the seller.

| Stream | Mechanism |
|---|---|
| Onboarding fee | The coworker task is billed in Sokosumi credits through `POST /coworkers/me/usage` (about $10–20 per API, covering the LLM and registration costs) |
| Take rate on packs (spike-gated) | 3% as a second output in the pack transaction, if Cardano x402 supports two outputs; otherwise billed monthly |
| Pro (roadmap) | Faster probes, analytics, Chainlink-scored badge |

Economics: a buyer pays the min-UTxO and fee overhead of about 1.4 ADA once per pack, about 0.014 ADA per call at 100 calls. Seller fees on escrow: Masumi 5% plus any Hirakumi fee, shown in full on the dashboard.

## 10. Data model

```
sellers      id, cardano_addr, sokosumi_user_id?, created_at
apis         id, seller_id, name, origin, path_prefix, openapi_url, openapi_sha256,
             state(intake|parsed|described|endpoints_confirmed|ownership_verified|rule_built|
                   priced|registering|live|retired), health(healthy|down),
             escrow_op_id, agent_identifier?, sokosumi_task_id?
onboard_steps api_id, step, status, attempts, output jsonb, updated_at
challenges   id, api_id, kind(http|wallet), token_or_nonce, expires_at, consumed_at, proof jsonb
operations   id, api_id, op_id, method, path, input_schema, side_effects_confirmed, enabled, description
rules        id, operation_id, version, definition jsonb, hash, plain_english
packs        id, api_id, calls, price_micros, escrow_price_micros
credit_tokens id, api_id, pack_id, token_hash UNIQUE, payer, status(pending|active|exhausted|revoked),
             remaining, payment_payload_hash UNIQUE, tx_hash?, created_at
calls        id, kind(credit|escrow), credit_token_id?, job_id?, blockchain_id?, api_id, op_id,
             rule_id, execution, verdict, verdict_reasons jsonb, latency_ms,
             input_hash, output_hash, created_at
probes       id, api_id, op_id, passed, latency_ms, reasons, at
test_inputs  id, operation_id, input jsonb
```

## 11. Edge cases

**Onboarding**
- Unparseable spec: stop, naming the line and the error.
- Swagger 2.0: out of scope; ask for 3.x.
- The LLM flags side effects wrongly: everything is blocked by default and the seller confirms each endpoint.
- Inferred rule too strict: only fields present in every sample are required, and the seller reviews it.
- Inferred rule too loose: the bad-input call must be rejected, otherwise the rule is tightened.
- Prompt injection in the spec: passed as quoted data; the LLM has no tools; publishing needs the seller's click.
- Someone imports another company's API: the challenge fails.
- Crash mid-onboarding: resume from the last saved step.
- Draft abandoned: expires after 7 days.
- Price below min-UTxO: impossible with packs, since the minimum pack price is set above it.

**Packs and credits**
- Settlement fails after the token is issued: the token stays pending forever and is unusable.
- Settlement unknown: the token stays pending; the reconcile job looks up the tx and activates it when found.
- The same payment replayed: `payment_payload_hash UNIQUE` returns the existing token.
- Concurrent calls race for the last credit: the atomic conditional update means exactly one wins.
- Fail, upstream 5xx or timeout: the credit is released.
- Token leaked: tokens are scoped to one API, stored hashed, shown once, and revocable from the dashboard.
- Seller goes permanently down while buyers hold credits: the credits were prepaid to the seller. The POC states this in the buyer terms; the roadmap is packs paid into escrow.
- The seller changes the rule: in the POC, rules are frozen once Live.
- The seller changes the pack price: existing credits are counted in calls, not money, so they're unaffected.

**Escrow**
- The buyer never locks funds: the job expires at `payByTime` and upstream is never called.
- Upstream is slow and the result is late: upstream is capped at 15s, far below `submitResultTime`; if the deadline is missed, the auto-refund applies.
- Fail: no result, so the auto-refund applies.
- Which operation a job runs: always the single escrow operation, so the input schema is unambiguous.

**Monitoring**
- Flaky network: needs a run of consecutive failures (3 in production, 2 in demo mode).
- Probes cost the seller upstream quota: they carry a header the seller can filter on.
- The monitor process dies: health keeps a "last checked" time; after 10 minutes the dashboard shows a stale warning and `/availability` keeps the last state.
- Registry lag: the dashboard and Sokosumi comment are immediate; the registry catches up on its next check.

**Security**
- SSRF: pinned-DNS HTTPS fetch, private, loopback, link-local and metadata IPs blocked, no redirects.
- Size limits: 256KB in, 1MB out.
- Sokosumi whitelisting refused: run the coworker in the dashboard chat.

## 12. Feasibility spike (hours 0–2)

| Owner | Check | Fallback |
|---|---|---|
| P1 | The x402-express template settles tUSDM on preprod through the hosted facilitator; the `onAfterSettle` and `onSettleFailure` hooks fire as expected; measure the time with `l1Confirmations: 0` | Local facilitator; tADA |
| P1 | Can one Cardano x402 payment carry two outputs (seller plus fee)? | Bill the fee monthly |
| P4 | The payment-service node runs on EC2 against preprod; registry registration shows Online; a non-200 `/availability` flips the agent to Offline (measure the check interval) | The x402-cardano-demo register script |
| P4 | Escrow: create payment, buyer locks, submit result; and no result → auto-refund after a short `submitResultTime`; can collection go to the seller's address? | Manual sweep, disclosed |
| P4 | What `POST /payment/x402` on the payment service does | Ignore it |
| P3 | Get a Sokosumi preprod coworker key (whitelisting) | Dashboard chat |
| P2 | CIP-30 `signData` from Eternl verifies with `checkSignature` | `@cardano-foundation/cardano-verify-datasignature` |
| P5 | Ask organisers how many tracks a project can enter | Cardano only |

## 13. Team and timeline

| Role | Owns |
|---|---|
| P1 Gateway | `apps/gateway`, `packages/core`, monitor |
| P2 Web | `apps/web`: onboarding screens, signing, review, API overview, sales |
| P3 Coworker | `apps/coworker`: Sokosumi integration or dashboard chat, state machine, LLM step |
| P4 Masumi & AWS | EC2, Docker Compose, Caddy, payment node, registry, escrow path |
| P5 Demo & pitch | `sellers/price-api`, `agents/buyer`, video, slides, write-up; CRE only after the hour-18 checkpoint |

- **0–2h:** spike, scaffold, wallets funded (tADA, tUSDM, preprod purchasing wallet).
- **By 10h:** packs, credits, pass/fail and 503 working end to end on preprod with manual onboarding.
- **By 16h:** escrow path, registry registration, monitor with truthful availability.
- **By 18h:** the coworker drives the whole flow. **Checkpoint:** if the core demo passes, P5 starts CRE (4-hour timebox).
- **22h:** feature freeze.
- **22–26h:** bug bash, record the video.
- **T−4h:** write-up and submission.

**Demo (3 minutes):**
- **0:00** The problem.
- **0:20** Onboarding on Sokosumi: the seller signs and approves.
- **1:05** Live on the registry, Online.
- **1:20** The agent buys a pack (one tx, Cardanoscan) and calls fast.
- **1:50** Break switch: 422 with credits unchanged, Down within 20s, Sokosumi alert, registry Offline (time-cut).
- **2:25** Escrow job pass and auto-refund (pre-recorded).
- **2:45** Vision and business model.

## 14. Out of scope

- Public QA and Pricer agents (first stretch goal after CRE).
- Drift detection, real-traffic scoring, anti-gaming.
- Swagger 2.0, upstream auth and encrypted secrets.
- Pro tier.
- Custodial ledger and payouts.
- Solana and NOWNodes.
- Side-effecting endpoints, async upstreams, streaming.
- DNS TXT ownership.
- LLM-judged quality.

## 15. Decisions

| Decision | Choice |
|---|---|
| Name | Hirakumi |
| x402 pricing | Call packs with credits; credits used only on pass |
| Custody | Non-custodial for x402 (`payTo` = seller); escrow collection checked in the spike |
| Escrow failure | No result submitted; automatic refund after `submitResultTime` |
| Offline signal | `/availability` returns 503 when down |
| LLM | One step (descriptions, plain-English rule, listing text) via Claude; everything else is code |
| Hosting | EC2 (gateway, coworker, payment node, Postgres, Caddy) plus Vercel (web, demo seller) |
| Gated items | Sokosumi integration (whitelisted by hour 2), CRE (core demo passes by hour 18) |
