# Hirakumi: any API, sold to AI agents, paid only when it passes

## Problem
AI agents increasingly buy data per call, but API sellers have no simple way to sell to them on Masumi: they would have to build and register an agent, handle Cardano payments and run an honest health endpoint. Buyers carry the risk: they pay even when a response is empty or stale. Paying per call on-chain doesn't work on Cardano either: every payment output carries about 1.2–1.5 ADA min-UTxO plus about 0.17 ADA in fees and waits for a confirmation.

## What we built
Hirakumi is a Sokosumi coworker that takes a read-only OpenAPI API to market in the Masumi agent economy. The seller confirms endpoints, proves ownership (an HTTP challenge file plus a CIP-30 wallet signature), and approves a price and a promise written in plain English. The result is a Masumi-registered agent with a monitored health status. Buyer agents either buy a call pack with one x402 payment, or hire per job through Masumi escrow. Credits and escrowed funds are consumed only when the response passes the published promise.

## Technical approach
- **Cardano / x402 (`@x402/*` 2.26.0, `cardano:preprod`):** each API gets an x402-protected pack route (`exact` scheme, tUSDM `USDM_PREPROD_ASSET`, `payTo` = the seller's verified address, so it's non-custodial) settled through the hosted preprod facilitator. The credit token is created *pending* and activated only in `onAfterSettle`, so an unsettled payment can never be used. One payment buys 100 calls: about 0.014 ADA overhead per call instead of about 1.4 ADA.
- **Credits only on pass:** a paid call atomically reserves one credit (`UPDATE … WHERE remaining > 0 RETURNING`), proxies upstream, and checks the response against a JSON Schema rule (ajv plus a `maxAgeSeconds` freshness keyword). Pass → commit and 200. Fail → release and 422 with the failing paths.
- **Masumi:** registration on the Masumi registry through our own payment-service node; MIP-003 endpoints (`start_job`, `status`, `availability`, `input_schema`); MIP-004 input and output hashes; escrow jobs where a failing result is simply not submitted, so Masumi's automatic refund after `submitResultTime` protects the buyer.
- **Truthful health:** an in-process monitor runs saved test inputs against the full rule (10s interval in demo mode). After 2 failures `/availability` returns 503, so the Masumi registry marks the agent Offline, and the paid routes answer 503 before any payment.
- **Sokosumi coworker:** onboarding state machine with one LLM step (Claude, structured output, no tools) for descriptions and plain-English rule text; health alerts as comments on the seller's task.
- **Chainlink CRE (stretch, simulation):** a CRE workflow run in simulation (cron trigger, HTTP with consensus) probes each live API's `/availability` and the seller endpoint, then writes uptime and pass-rate scores to a `ScoreRegistry` consumer contract on Base Sepolia via `writeReport`.
- **Measured on preprod:** (measured: pack payment seconds), (measured: added gateway latency p50 ms), (measured: seconds from break to Down).

## Deployment and scaling
- Today: one AWS EC2 instance (ap-southeast-1) with Docker Compose (gateway, Masumi payment service, Postgres, Caddy for HTTPS, coworker) plus Vercel for the dashboard and the demo seller.
- Scale-out: the gateway is stateless apart from Postgres and in-memory health, so it scales horizontally behind Caddy with health state moved to Postgres or Redis; one payment-service node serves many sellers; credit checks are one indexed lookup plus one atomic update, with no on-chain step per call.
- Production path: mainnet USDM, packs paid into escrow for buyer protection, a 3% take rate as a second output, and drift detection.

## Links
Repo · Live dashboard · Demo API · Video · Slides (filled in from submission-checklist.md).
