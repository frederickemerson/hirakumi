# Stress and abuse suite

Adversarial tests for Hirakumi: money invariants under concurrency, protocol fuzzing, hostile sellers, property
tests of the promise engine and the escrow maths, web route abuse, and a live load run against a gateway process.
Everything runs on localhost against throwaway databases. Nothing reaches a chain, a facilitator or a real seller:
the facilitator stub refuses every payment.

## Run

```sh
pnpm db:up                      # the dev Postgres on localhost:5432 (hirakumi/hirakumi)
node stress/run.mjs             # about 5 minutes
node stress/run.mjs --long      # heavier: 20x property runs, 300k-call soak, 2 min throughput
node stress/run.mjs --only=prop,gateway       # parts: prop, gateway, web, live
STRESS_ONLY=throughput,race node stress/run.mjs --only=live
```

`pnpm --filter @hirakumi/stress stress` does the same as the first command. The runner recreates the databases
`hirakumi_stress`, `hirakumi_stress_test` and `hirakumi_stress_web_test` on every run, starts its own processes with a
clean environment (never your `.env`), and stops them at the end. Ports: gateway 4931, seller 4910, facilitator 4999
(`STRESS_GW_PORT`, `STRESS_SELLER_PORT`, `STRESS_FAC_PORT`). `STRESS_PG_URL` points at another local Postgres server.

## What it covers

| Part | Where | What |
| --- | --- | --- |
| prop | `prop/` | fast-check properties: escrow payouts and Settle obligations (sum == locked, fee bounds, per-address merge), IOU sign/verify/parse, datum round trips and hostile CBOR, rule inference and hash stability, kept answers re-check as kept, text promises, key-leak detection and redaction across encodings, SSRF address blocking, upstream request building, settlement policy. |
| gateway | `gateway/` | The gateway app on a real local port with the test harness (fresh schema, fake facilitator, fake chain): credits used == kept promises under chaos, last-credit races, one payment buys one pack (across APIs and packs), escrow quote and IOU gate races, close races; x402 header fuzzing and single-field offer mutations; raw-socket smuggling, 63/66 KB headers, slowloris, 2 000 connections; hostile paths, queries and bodies; hostile sellers (hangs, endless streams, 10 MB, redirects to metadata, broken HTTP); key echo in 15 encodings; SSRF origins in strict mode; the start_job limiter under IPv6 sweeps; escrow jobs with unstorable answers. |
| web | `web/` | Next.js route handlers called directly: auth bypass and forged sessions on every seller route, cross-site requests, Try it live / Buy / Ask rate limits under concurrent abuse and spoofed X-Forwarded-For, one-listing and delete races, sign-in replay, intake with hostile URLs and keys. |
| live | `load/` | A gateway process under load: throughput and latency with exact credit accounting, a 60k mixed-call soak with RSS sampling, last-credit races, receipts of a heavy token, a flip-flopping seller, broken -> Down -> recovered, hybrid offers and paid retries, ownership re-check pause and restore under load. |

Results of the live run are printed as `STRESS_RESULTS <json>`.
