<p align="center"><img src="docs/brand/logo.png" alt="Hirakumi" width="420"></p>

# Hirakumi

Turn any read-only API into a paid supplier for AI agents on Cardano. Buyers pay once for a pack of calls with x402, and a credit is used **only when the response passes the published promise**. Built for TOKEN2049 Origins, Cardano "Agentic Commerce" track. Preprod only.

- Live dashboard: https://hirakumi.vercel.app
- Try a live API (real preprod credits): https://hirakumi.vercel.app/p/api_eejiaioyqt/try
- Gateway (x402 + MIP-003): https://52-70-235-103.sslip.io
- Demo seller API: https://price.52-70-235-103.sslip.io/openapi.json
- Video, slides, write-up: see `docs/submission/`

## What APIs it takes
- **With an OpenAPI file:** paste its link. Hirakumi reads the endpoints from it.
- **Without one:** give the base URL and a few example requests, one per line, for example `GET /price?symbol=ADA`, `GET /coins/{id=cardano}?days?=7` (a path parameter and an optional query) or `POST /search {"q": "ada"}` (a JSON body). Hirakumi builds an OpenAPI 3.1 file from them (`packages/core/src/samples.ts`), and every value is also an example for the test calls. The API's key never goes in these lines: a line whose name or value looks like a key gets a warning (a name can't prove a key, so `key=BTC` works), and when the seller saves the key, Hirakumi refuses it if that exact key, in any common encoding, is in the example requests, the OpenAPI file's descriptions or the endpoints' examples. This is on the setup page of the website (choose "I don't", shown when `SAMPLES_INTAKE=1`), or in a Sokosumi task comment.
- **APIs that need a key:** the seller adds it on the ownership page, as a header (the default and recommended, for example `Authorization: Bearer …`) or a query parameter, which shows a warning that keys in URLs leak more easily. The web app seals it with the gateway's public key (X25519), bound to the API's id, address, path and placement, so only the gateway can read it and only for that API. Changing the API's address means saving the key again. The page never shows the key again (at most its last 4 characters). The gateway adds the key only after the call's URL is checked to be inside the proven origin and folder, and it withholds any answer in which it finds the key. That check is defence in depth: it catches common encodings (raw, percent-encoded at any depth up to 8 rounds, a `+` read as a space, JSON and HTML escapes, base64, hex) but cannot catch every way an API might transform it, which is one more reason to prefer a header.
- **Answers:** JSON is checked against a JSON Schema as before. Text answers (CSV, XML, plain text, YAML) are checked as text: the status (2xx), the media type, not empty, not an HTML page unless the type is HTML or XML, and a required phrase that every good answer contains, matched in any case. A text listing can only be published once the seller has confirmed that phrase: Hirakumi suggests one from the test calls (only when they used at least two different inputs, and only one the answer to a wrong request lacks), and the seller keeps it, edits it or types another. A phrase that one of the good test answers lacks is refused. Hirakumi does not judge an answer by its words (a CSV may have an `error` column, a log API returns stack traces), so the seller's API must answer errors with a 4xx or 5xx status. Binary answers (images, PDF, files) are not supported.
- Every endpoint must be read-only. Read-only is something the seller confirms for endpoints that may change data (PUT, PATCH, DELETE and POST), not something Hirakumi can prove.

## Who you trust, in each payment mode
With `PACK_MODE=hybrid` (the default) the gateway picks one of the first two per purchase: escrow for a pack of 2 tUSDM or more, a seller under 99% uptime over 7 days, or a listing under 7 days old; direct otherwise, or when the buyer sends no IOU key. The 402 says which and why in `extra.settlement`. A buyer that sends `X-Hirakumi-Settlement: escrow` always gets escrow, or a 503 if this pack can't be escrowed (never a quiet direct offer); the buyer agent does this with `REQUIRE_ESCROW=1`.

| | Escrow pack channel (`PACK_MODE=escrow`) | Direct packs (`PACK_MODE=direct`) | Masumi escrow jobs |
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
  - Ownership proof is a response header: the seller makes their API send `X-Hirakumi-Verify: <code>` (the per-API code from the ownership page), and the gateway sends one plain `GET` to the API's base URL (origin plus path prefix, no query, no redirects followed) through the SSRF-safe fetch. Any status counts, a 404 page included. The code proves the base URL's folder and below it, and the URL is refused if it contains the code. The OpenAPI file is no longer part of the proof, so it can be hosted anywhere (for example raw.githubusercontent.com); the API's origin and path prefix come from its `servers[0]`. The CIP-30 wallet signature step is unchanged.

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
pnpm --filter @hirakumi/gateway upstream-auth-keys   # UPSTREAM_AUTH_PUBLIC_KEY for the web app, UPSTREAM_AUTH_PRIVATE_KEY for the gateway only
pnpm test                       # all workspace tests
docker compose up -d            # postgres, payment-service, gateway, coworker, caddy
pnpm --filter @hirakumi/price-api dev                                   # demo seller on :4100
pnpm --filter @hirakumi/buyer run pack -- --api <apiId> --calls 10      # buy a pack, call with credits ("run": plain `pack` is pnpm's own command)
pnpm --filter @hirakumi/buyer run escrow -- --api <apiId>                # one escrow job
```
For APIs other than the demo, `pack` takes `--op <opId>`, and both take `--query name=value` (repeatable). Text answers (CSV, XML) are printed as they came.
### Sell an API from a Sokosumi task
Assign a task to the Hirakumi coworker and put your OpenAPI link in its description (or reply with it). An API without an OpenAPI file works too: put its base URL and the example requests, one per line, in the description or a reply. A linked seller's API starts from them at once; a first-time seller gets the endpoint list and pastes the same lines on the website's setup page. The coworker reads the file through the SSRF-safe fetch and posts each of the web's 7 steps as a task comment. Replies it understands: `sell 1 2` (choose endpoints; add `readonly` for endpoints that may change data), `price 2` or `price 3.5 for 200 calls` (pack price, before publishing). Free text is mapped to the offered choice by one structured LLM step and then validated the same way. Signing in, proving ownership and approving the publish need your wallet, so for those it posts one deep link to that exact web step; a `publish` comment is refused. A first-time seller signs in once through the setup link; after that the Sokosumi account is linked to the wallet and new tasks start at once. When the API is Live the task gets the status page, try page and registry token links and is set `COMPLETED`.

Break the demo seller (needs `ADMIN_TOKEN`):
```bash
curl -XPOST $PRICE_API_URL/admin/break -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"mode":"empty"}'   # or "stale", "ok"
```
## License
MIT
