<p align="center"><img src="docs/brand/logo.png" alt="Hirakumi" width="420"></p>

# Hirakumi (開く)

Turn any read-only OpenAPI API into a paid supplier for AI agents on Cardano. Buyers pay once for a pack of calls with x402, and a credit is used **only when the response passes the published promise**. Built for TOKEN2049 Origins, Cardano "Agentic Commerce" track. Preprod only.

- Live dashboard: https://hirakumi.vercel.app
- Try a live API (real preprod credits): https://hirakumi.vercel.app/p/api_eejiaioyqt/try
- Gateway (x402 + MIP-003): https://52-70-235-103.sslip.io
- Demo seller API: https://price.52-70-235-103.sslip.io/openapi.json
- Video, slides, write-up: see `docs/submission/`

## Who you trust, in each payment mode
| | Escrow pack channel (`PACK_MODE=escrow`) | Direct packs (default today) | Masumi escrow jobs |
|---|---|---|---|
| Where the money sits | Cardano contract until settlement | Seller's wallet from purchase | Masumi contract per job |
| What the seller can be paid | Only calls the buyer signed IOUs for | The whole pack up front | The job, if a passing result is submitted |
| Who counts | Buyer-signed IOUs, checked on-chain | Hirakumi's database (auditable at `/receipts`) | Nothing to count |
| If Hirakumi disappears | Buyer closes and settles alone and gets everything unsigned back | Remaining credits can't be used | No result, so Cardano refunds |
| Cost | One lock plus one close/settle per pack | ~0.014 ADA overhead per call | A full payment and minutes per job |

The pass/fail check runs on our gateway in every mode, against a rule whose hash is published before payment. The escrow channel is the validator in `contracts/pack-escrow` (Aiken, Plutus V3, 175 tests), proven end to end on preprod, including after the 6 Oct security fixes that changed its script address (see `docs/submission/submission-checklist.md`).

## Where each technology is used

### Cardano and x402 (`@x402/*` pinned to 2.26.0, `cardano:preprod`)
- `apps/gateway/`: x402-protected pack route (`exact` scheme, tUSDM, `payTo` = seller), `onAfterSettle` token activation, credit-gated proxy
- `agents/buyer/src/payClient.ts`: buyer agent using `@x402/fetch` `wrapFetchWithPayment`, `toClientCardanoSigner`, spend controls for `USDM_PREPROD_ASSET`
- `agents/buyer/src/packBuyer.ts`, `agents/buyer/src/cli/pack.ts`: the pack-buyer demo agent
- `apps/web/`: CIP-30 wallet signature for login and ownership (any CIP-30 wallet: Lace, Eternl, …); public status page and the try-it-live page

### Masumi
- `packages/masumi/`: payment-service and registry client (registration, payment requests, result submission, purchases)
- `apps/gateway/`: MIP-003 endpoints (`start_job`, `status`, `availability`, `input_schema`), MIP-004 hashing via `packages/core/`
  - `start_job` allows 10 requests per minute per client address. Sokosumi calls `start_job` with only a `Content-Type` header (no key, no signature, and MIP-003 defines none), and its backend uses a few shared IPs. Set `START_JOB_TRUSTED_CIDRS` (comma-separated IPv4/IPv6 CIDRs, empty by default) to give each address in those ranges 600 per minute. The gateway trusts exactly one proxy (Caddy), so a client can't fake its address with `X-Forwarded-For`.
- `agents/buyer/src/escrowBuyer.ts`, `agents/buyer/src/cli/escrow.ts`: escrow buyer agent
- `apps/coworker/`: Sokosumi coworker (onboarding, health alerts); LLM steps use OpenAI structured output (`gpt-5.5`, `responses.parse`)
- `docker-compose.yml`: the official Masumi payment-service node

### Not built
- Chainlink CRE uptime scoring was a stretch goal and is not in this repo.

## Repository layout
`apps/gateway` · `apps/web` · `apps/coworker` · `packages/core` · `packages/db` · `packages/masumi` · `sellers/price-api` · `agents/buyer` · `contracts/pack-escrow` · `packages/escrow` · `db/migrations` · `docs/`

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
### Sell an API from a Sokosumi task
Assign a task to the Hirakumi coworker and put your OpenAPI link in its description (or reply with it). The coworker reads the file through the SSRF-safe fetch and posts each of the web's 7 steps as a task comment. Replies it understands: `sell 1 2` (choose endpoints; add `readonly` for endpoints that may change data), `price 2` or `price 3.5 for 200 calls` (pack price, before publishing). Free text is mapped to the offered choice by one structured LLM step and then validated the same way. Signing in, proving ownership and approving the publish need your wallet, so for those it posts one deep link to that exact web step; a `publish` comment is refused. A first-time seller signs in once through the setup link; after that the Sokosumi account is linked to the wallet and new tasks start at once. When the API is Live the task gets the status page, try page and registry token links and is set `COMPLETED`.

Break the demo seller (needs `ADMIN_TOKEN`):
```bash
curl -XPOST $PRICE_API_URL/admin/break -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"mode":"empty"}'   # or "stale", "ok"
```
## License
MIT
