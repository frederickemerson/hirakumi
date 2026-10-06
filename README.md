# Hirakumi (開く)

Turn any read-only OpenAPI API into a paid supplier for AI agents on Cardano. Buyers pay once for a pack of calls with x402, and a credit is used **only when the response passes the published promise**. Built for TOKEN2049 Origins, Cardano "Agentic Commerce" track. Preprod only.

- Live dashboard: https://hirakumi.vercel.app
- Try a live API (real preprod credits): https://hirakumi.vercel.app/p/api_eejiaioyqt/try
- Gateway (x402 + MIP-003): https://52-70-235-103.sslip.io
- Demo seller API: https://price.52-70-235-103.sslip.io/openapi.json
- Video, slides, write-up: see `docs/submission/`

## Who you trust, in each payment mode
Buyers pick their trust level.

| | Call packs (x402) | Escrow jobs (Masumi) |
|---|---|---|
| Where the money sits | Seller's wallet, from the moment of purchase (on-chain) | Masumi escrow contract until a result or the deadline (on-chain) |
| Who decides pass or fail | Hirakumi's gateway, against a rule whose hash is published before you pay | Hirakumi's gateway, same rule |
| Who counts what's left | Hirakumi's database | Nothing to count: one job per lock |
| If a call is wrongly charged | Visible in your receipts (`GET /a/<apiId>/receipts`), no automatic refund | Dispute window before unlock |
| If Hirakumi goes offline | Remaining credits can't be used | No result is submitted, so Cardano refunds you |
| Cost per call | ~0.014 ADA overhead (one payment per 100 calls) | A full payment and minutes per job |

Packs are fast and cheap: you pay once on Cardano and the gateway uses a credit only when a response passes. Every credit call is logged with its verdict, rule hash and MIP-004 style input/output hashes, and the token holder can fetch them from `/receipts` and recompute the output hash from the body they received. Escrow needs much less trust: Masumi's contract holds the money, and if we don't deliver a passing result, Cardano refunds you automatically. Next step on the roadmap: pack money paid into escrow and released to the seller in batches as calls pass.

## Where each technology is used

### Cardano and x402 (`@x402/*` pinned to 2.26.0, `cardano:preprod`)
- `apps/gateway/`: x402-protected pack route (`exact` scheme, tUSDM, `payTo` = seller), `onAfterSettle` token activation, credit-gated proxy
- `agents/buyer/src/payClient.ts`: buyer agent using `@x402/fetch` `wrapFetchWithPayment`, `toClientCardanoSigner`, spend controls for `USDM_PREPROD_ASSET`
- `agents/buyer/src/packBuyer.ts`, `agents/buyer/src/cli/pack.ts`: the pack-buyer demo agent
- `apps/web/`: CIP-30 wallet signature for login and ownership (any CIP-30 wallet: Lace, Eternl, …); public status page and the try-it-live page

### Masumi
- `packages/masumi/`: payment-service and registry client (registration, payment requests, result submission, purchases)
- `apps/gateway/`: MIP-003 endpoints (`start_job`, `status`, `availability`, `input_schema`), MIP-004 hashing via `packages/core/`
- `agents/buyer/src/escrowBuyer.ts`, `agents/buyer/src/cli/escrow.ts`: escrow buyer agent
- `apps/coworker/`: Sokosumi coworker (onboarding, health alerts); LLM steps use OpenAI structured output (`gpt-5.5`, `responses.parse`)
- `docker-compose.yml`: the official Masumi payment-service node

### Not built
- Chainlink CRE uptime scoring was a stretch goal and is not in this repo.

## Repository layout
`apps/gateway` · `apps/web` · `apps/coworker` · `packages/core` · `packages/db` · `packages/masumi` · `sellers/price-api` · `agents/buyer` · `db/migrations` · `docs/`

## Run it
Requirements: Node 22+, pnpm, Docker. A funded preprod wallet (tADA from https://docs.cardano.org/cardano-testnets/tools/faucet, tUSDM from https://tusdm.moneta.global) and a Blockfrost preprod key.

```bash
pnpm install
cp .env.example .env            # fill in the values; see comments
pnpm test                       # all workspace tests
docker compose up -d            # postgres, payment-service, gateway, coworker, caddy
pnpm --filter @hirakumi/price-api dev                                   # demo seller on :4100
pnpm --filter @hirakumi/buyer run pack -- --api <apiId> --calls 10      # buy a pack, call with credits ("run": plain `pack` is pnpm's own command)
pnpm --filter @hirakumi/buyer run escrow -- --api <apiId>                # one escrow job
```
Break the demo seller (needs `ADMIN_TOKEN`):
```bash
curl -XPOST $PRICE_API_URL/admin/break -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"mode":"empty"}'   # or "stale", "ok"
```
## License
MIT
