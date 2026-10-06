# Hirakumi (開く)

Turn any read-only OpenAPI API into a paid supplier for AI agents on Cardano. Buyers pay once for a pack of calls with x402, and a credit is used **only when the response passes the published promise**. Built for TOKEN2049 Origins, Cardano "Agentic Commerce" track. Preprod only.

- Live dashboard: https://hirakumi.vercel.app
- Gateway: https://api.hirakumi.app
- Demo seller API: https://hirakumi-price-api.vercel.app/openapi.json
- Video, slides, write-up: see `docs/submission/`

## Where each technology is used

### Cardano and x402 (`@x402/*` pinned to 2.26.0, `cardano:preprod`)
- `apps/gateway/`: x402-protected pack route (`exact` scheme, tUSDM, `payTo` = seller), `onAfterSettle` token activation, credit-gated proxy
- `agents/buyer/src/payClient.ts`: buyer agent using `@x402/fetch` `wrapFetchWithPayment`, `toClientCardanoSigner`, spend controls for `USDM_PREPROD_ASSET`
- `agents/buyer/src/packBuyer.ts`, `agents/buyer/src/cli/pack.ts`: the pack-buyer demo agent
- `apps/web/`: CIP-30 wallet signature for ownership (Eternl)

### Masumi
- `packages/masumi/`: payment-service and registry client (registration, payment requests, result submission, purchases)
- `apps/gateway/`: MIP-003 endpoints (`start_job`, `status`, `availability`, `input_schema`), MIP-004 hashing via `packages/core/`
- `agents/buyer/src/escrowBuyer.ts`, `agents/buyer/src/cli/escrow.ts`: escrow buyer agent
- `apps/coworker/`: Sokosumi coworker (onboarding, health alerts)
- `docker-compose.yml`: the official Masumi payment-service node

### Chainlink CRE (CRE workflow run in simulation; included only if shipped)
- `cre/project.yaml`, `cre/secrets.yaml`: CRE project settings (Base Sepolia RPC)
- `cre/scorer/main.ts`: the workflow: cron trigger, HTTP capability with consensus, `writeReport` to the consumer contract
- `cre/scorer/logic.ts`, `cre/scorer/logic.test.ts`: probe evaluation and report encoding
- `cre/scorer/workflow.yaml`, `cre/scorer/config.staging.json`: workflow settings
- `contracts/score-registry/src/ScoreRegistry.sol`: consumer contract implementing `onReport` (via `ReceiverTemplate`) storing `apiId → (uptimeBps, passRateBps, at)`
- `contracts/score-registry/src/interfaces/*`: MIT-licensed receiver interfaces from smartcontractkit/x402-cre-price-alerts
- Honest status: this is a **CRE workflow run in simulation** (`cre workflow simulate --broadcast`), writing real transactions to Base Sepolia through the simulation forwarder. It is not deployed to a DON.

## Repository layout
`apps/gateway` · `apps/web` · `apps/coworker` · `packages/core` · `packages/db` · `packages/masumi` · `sellers/price-api` · `agents/buyer` · `cre/scorer` · `contracts/score-registry` · `db/migrations` · `docs/`

## Run it
Requirements: Node 22+, pnpm, Docker. A funded preprod wallet (tADA from https://docs.cardano.org/cardano-testnets/tools/faucet, tUSDM from https://tusdm.moneta.global) and a Blockfrost preprod key.

```bash
pnpm install
cp .env.example .env            # fill in the values; see comments
pnpm test                       # all workspace tests
docker compose up -d            # postgres, payment-service, gateway, coworker, caddy
pnpm --filter @hirakumi/price-api dev                                   # demo seller on :4100
pnpm --filter @hirakumi/buyer pack -- --api <apiId> --calls 10          # buy a pack, call with credits
pnpm --filter @hirakumi/buyer escrow -- --api <apiId>                    # one escrow job
```
Break the demo seller (needs `ADMIN_TOKEN`):
```bash
curl -XPOST $PRICE_API_URL/admin/break -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"mode":"empty"}'   # or "stale", "ok"
```
CRE (optional): see `cre/README` section below. Needs Bun ≥ 1.2.21, the CRE CLI (`curl -sSL https://app.chain.link/cre/install.sh | bash`, `cre login`) and Foundry.
```bash
cd cre/scorer && bun install && cd .. && cre workflow simulate scorer --target staging-settings --non-interactive --trigger-index 0 --broadcast
```

## License
MIT
