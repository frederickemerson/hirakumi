# Hirakumi P4 — Masumi & AWS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Contract v1.1:** read the "Contract v1.1 amendments" section at the end of `2026-10-06-hirakumi-00-contract.md` before starting. Your recommended additions are adopted as M1–M5. The database is decided: Neon, which removes the Hirakumi Postgres from your compose file.

**Goal:** Run the official Masumi payment service on one AWS EC2 host behind Caddy TLS. Ship `packages/masumi` (the contract's TypeScript API) with mocked-fetch tests and live preprod scripts. Prove on preprod that registry registration reaches Online, that a 503 `/availability` turns it Offline (and measure how long that takes), and that escrow works both ways: result submitted and paid, or no result and refunded automatically.

**Architecture:** The EC2 host (t3.large, ap-southeast-1, Elastic IP, DNS `api.<domain>`) runs one Docker Compose project with these services:

- `postgres`: two databases, `hirakumi` and `masumi`.
- `payment-service`: `ghcr.io/masumi-network/masumi-payment-service:0.29.0`, bound to `127.0.0.1:3001` only.
- `gateway` and `coworker`: P1 and P3 code, built from one generic Dockerfile.
- `availability-stub`: lets us measure the registry health check before the gateway exists.
- `caddy`: automatic HTTPS for `PUBLIC_BASE_URL`, reverse proxy to the gateway.

`packages/masumi` is a thin typed client over the payment service REST API (`token` header, `{status,data}` envelope) and the Masumi registry service. It checks every rule the node enforces before calling it, so callers get a plain-English error instead of a 400 from the chain.

**Tech Stack:** AWS CLI v2, Ubuntu 24.04 amd64, Docker Engine + Compose v2, Caddy 2.11, Postgres 16, Masumi payment service 0.29.0 (V2 escrow `Web3CardanoV2`), Node 22, TypeScript ESM, pnpm workspaces, vitest 5 (`vi.stubGlobal('fetch')` fake server), tsx, Blockfrost preprod, jq/curl.

**Spec:** `docs/superpowers/specs/2026-10-06-hirakumi-design.md` (v4)
**Contract:** `docs/superpowers/plans/2026-10-06-hirakumi-00-contract.md`

---

## Global Constraints (exact values from contract)

- Network: **`cardano:preprod` only**. Reject any address that does not start with `addr_test1`. The payment service network value is `"Preprod"`.
- **Escrow (Masumi) token**: policy `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde`, asset name `0014df10745553444d`. Unit (concatenated) = `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d` = `MASUMI_ESCROW_UNIT`.
- **Pack (x402) token, never used by P4 code**: `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d` (`USDM_PREPROD_ASSET`, claim at https://tusdm.moneta.global).
- Both tokens have 6 decimals. Amounts are integer **micros**: `bigint` in TypeScript and SQL, `string` in JSON.
- Node **22**+, TypeScript, ESM (`"type": "module"`), `tsx` to run, **vitest** for tests, **pnpm** workspaces. Pin exact versions (no `^`).
- Env names (contract `.env.example`): `DATABASE_URL`, `PUBLIC_BASE_URL`, `INTERNAL_TOKEN`, `DEMO_MODE`, `ALLOW_INSECURE_UPSTREAM`, `FACILITATOR_URL`, `GATEWAY_PORT=4021`, `PAYMENT_SERVICE_URL=http://payment-service:3001/api/v1`, `PAYMENT_SERVICE_TOKEN`, `MASUMI_ESCROW_UNIT`, `BLOCKFROST_PROJECT_ID`, `ANTHROPIC_API_KEY`, `SOKOSUMI_API_URL`, `SOKOSUMI_COWORKER_API_KEY`, `WEB_BASE_URL`, `BUYER_MNEMONIC`, `SELLER_DEMO_ADDRESS`.
- `packages/masumi` public API: exactly the contract's signatures (`MasumiConfig`, `registerAgent`, `getAgentIdentifier`, `getRegistryStatus`, `createPaymentRequest`, `getPaymentState`, `submitResult`, `createPurchase`). Additions are optional fields and extra exports only (see "Contract deltas").
- `/availability`: **200** `{status:"available", type:"masumi-agent", message}`, or **503** `{status:"unavailable", message, estimated_downtime_seconds}`. The registry marks any non-200 as Offline.
- Monitor timing (P1): production 120 s / 3 fails / 2 passes; `DEMO_MODE=1` 10 s / 2 / 2.
- Checkpoint **hour 16**: escrow pass and auto-refund on preprod, registry registration Online, monitor flips `/availability`. If missed, escrow becomes a pre-recorded demo only.

## Verified payment-service facts (source: `masumi-payment-service` tag `0.29.0`, commit `71455701`, read on 2026-10-06)

| Fact | Where verified | Consequence |
|---|---|---|
| Published image `ghcr.io/masumi-network/masumi-payment-service:0.29.0` exists; single-arch manifest built on `ubuntu-22.04` runners (amd64) | GHCR tag list + manifest | Use an **x86_64** instance (t3), not Graviton |
| The image does **not** run migrations. The runtime stage omits `packages/`, which `prisma/seed.ts` imports (`@masumi/payment-core`) | `Dockerfile`, `prisma/seed.ts` | Migrate and seed from a source checkout of tag `0.29.0` in a `node:20` container (Task 3) |
| Seeding needs `DATABASE_URL`, `ENCRYPTION_KEY` (≥20 chars), `BLOCKFROST_API_KEY_PREPROD`. `ADMIN_KEY` becomes the admin API token. Blank wallet mnemonics are generated and **printed once** | `README.md`, `.env.example`, `packages/payment-core/src/config.ts` | Capture the seed log once, then shred it |
| Auth header `token: <key>`. Success envelope `{status:"success",data}`; error `{status:"error",error:{message}}`. Swagger UI at `/docs`, raw spec JSON at `/api-docs` (not under `/api/v1`) | `endpoint-factory.ts`, `src/app.ts` | `packages/masumi/src/http.ts` |
| `GET /api/v1/health` (no auth) → `{status:"ok"}` | `routes/api/health` | compose healthcheck |
| V2 preprod escrow `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`; registry policy `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b` | `payment-core/src/config.ts` DEFAULTS | Smoke check asserts it |
| `POST /registry` (V2): `supportedPaymentSources:[{chain:"Cardano",network,paymentSourceType:"Web3CardanoV2",address,pricing:{pricingType:"Fixed",fixed:[{asset,amount}]}}]` is **required**; `AgentPricing` is **forbidden** for V2. Also `sellingWalletVkey` (56 hex), `name`/`description` ≤250, `Tags` 1–15 × ≤63, `ExampleOutputs` ≤25, `Capability`, `Author.name` | `routes/api/registry/schemas.ts`, `payment-core/src/payment-source.ts` | The masumi-skills docs show the V1 shape. Do not copy it |
| The registry mint is signed and paid by the **selling** wallet (`sellingWalletVkey`). The NFT stays in that wallet unless `recipientWalletAddress` is set | `routes/api/registry/index.ts` | Spec §5 says "purchasing wallet pays the mint". **Wrong**: fund the selling wallet |
| `GET /registry?network&filterPaymentSourceType=Web3CardanoV2&limit≤100&cursorId` → `{Assets:[{id,state,agentIdentifier,error,…}]}`. States: `RegistrationRequested/Initiated/Confirmed/Failed`, `Deregistration*`, `Update*` | `registry/schemas.ts`, `prisma/schema.prisma` | `getAgentIdentifier` |
| `POST /payment` (V2) requires `supportedPaymentSourceIndex` (0). `identifierFromPurchaser` = **14–26 hex chars**; `inputHash` hex. Times are ISO strings in, unix-ms **strings** out | `routes/api/payments/schemas.ts`, `index.ts` | Input validation |
| Node timing rules: `submitResultTime ≥ now+15 min`; `payByTime ≤ submitResultTime−5 min`; `payByTime ≥ now−5 min`; `unlockTime ≥ submitResultTime+15 min` (default **+6 h**); `externalDisputeUnlockTime ≥ unlockTime+15 min` (default +12 h). `/purchase` re-checks the same rules at purchase time | `payments/index.ts:132-163`, `purchases/shared.ts:47-67` | **A "short submitResultTime" is at least 15 minutes.** We send unlock = submit+16 min and dispute = unlock+16 min |
| **Auto-refund**: the buyer node withdraws the refund when `onChainState ∈ {FundsLocked, RefundRequested}`, `resultHash` is null, and `submitResultTime ≤ now−10 min` (needs `AUTO_WITHDRAW_REFUNDS=true`) | `payment-source-v2/.../automatic-decisions/service.ts:101-121`, `collect-refund/service.ts:1119` | Fail path takes about 20 + 10 + batch ≈ **31–35 min** after the payment request |
| `POST /payment` takes optional `sellerReturnAddress` (preprod pubkey address). V2 collection pays to `decodedContract.sellerReturnAddress ?? request.sellerReturnAddress ?? SmartContractWallet.collectionAddress ?? walletAddress` | `payments/schemas.ts`, `payment-source-v2/.../collection/service.ts:236-240` | **Escrow earnings can go straight to the seller's address**, per payment. Proved live in Task 6 |
| `POST /payment/submit-result {network, blockchainIdentifier, submitResultHash}`. `submitResultHash` is **exactly 64 hex** | `payments/submit-result/index.ts:16-19` | The skill docs say input+output hash (128 hex). That is **rejected** |
| `POST /purchase` body: `blockchainIdentifier, network, paymentSourceType, smartContractAddress, supportedPaymentSourceIndex, inputHash, sellerVkey` (lower-case k), `agentIdentifier, Amounts?, payByTime/submitResultTime/unlockTime/externalDisputeUnlockTime` (unix-ms strings), `identifierFromPurchaser, sellerReturnAddress?`. The same node can be seller and buyer (its own e2e suite does it) | `purchases/schemas.ts`, `tests/e2e/helperFunctions.ts:655-687` | `createPurchase` |
| `POST /payment/resolve-blockchain-identifier` and `/purchase/resolve-blockchain-identifier` `{network, blockchainIdentifier}` → full record incl. `onChainState` (`null` = not paid yet; `FundsLocked, FundsOrDatumInvalid, ResultSubmitted, RefundRequested, Disputed, WithdrawAuthorized, RefundAuthorized, Withdrawn, RefundWithdrawn, DisputedWithdrawn`) | `resolve-blockchain-identifier`, `prisma/schema.prisma` enum `OnChainState` | `getPaymentState` mapping |
| `POST /payment/x402 {network, blockchainIdentifier, buyerAddress}` → `{unsignedTxCbor, collateralReturnLovelace}`. It builds an **unsigned escrow-lock tx** for an external buyer wallet against an existing payment request. It is **not** an x402 facilitator and does not settle pack payments. Read-tier auth, 30 req/min | `routes/api/payments/x402/*` | Not used for packs. Task 7 records a live call |
| Scheduler interval env vars have code defaults of 15–30 s (minimum 5). `.env.example` sets 180–300 s. `BLOCK_CONFIRMATIONS_THRESHOLD` code default 1 | `payment-core/src/config.ts` | `deploy/masumi.env.example` sets them explicitly |
| **Registry service** (managed `https://registry.masumi.network/api/v1`) needs a `token` (`{"message":"No token provided"}` without one). The health check fetches `{apiBaseUrl}/availability` with `redirect:'manual'` and a 32 s timeout. Non-200 → **Offline**. Body `agentIdentifier` must equal the NFT, else **Invalid**; otherwise `type:"masumi-agent"` → Online. Private URLs → Invalid. The periodic job (default every 100 s) re-checks the **50 least-recently-checked** Online/Offline entries per source, so **Invalid entries are never re-checked**. `POST /registry-entry-refresh/` forces a fresh check of one entry | `masumi-registry-service` `health-check.service.ts:67-163`, `registry-health-check-job.ts:9-60`, `registry-entry.service.ts:225-245`, live curl | Needs `REGISTRY_API_KEY`. The real per-agent interval depends on preprod registry size: **measure it** (Task 5) |

**Not verified (each has an explicit check):** `ez.dateIn` accepting `toISOString()` output (Task 6 step 2, live). The live `/api-docs` containing every field name above (Task 13 smoke). `prisma:seed` working from the `node:20-bookworm` checkout (Task 3 step 4). How to get a `REGISTRY_API_KEY` for the managed registry (Task 5 step 1). The real registry check interval (Task 5). Collection reaching `sellerReturnAddress` on chain (Task 6 step 5). The x402-demo `register` script's address having the same payment key hash as the node's selling wallet (Task 18 step 2).

## Review Focus (5 failure modes most likely to bite users)

1. **The two tUSDM tokens get mixed up.** Escrow priced or funded in `e675b46e…` (x402) instead of `16a55b2a…` (Masumi) makes every purchase fail at `/purchase` or lock nothing. *Check:* `registerAgent` rejects any `unit !== MASUMI_ESCROW_UNIT` (Task 10 test "rejects bad listings…"). The smoke script requires the purchasing wallet to hold ≥3 Masumi tUSDM by exact unit (Task 13). `escrow-e2e` refuses a payment not priced in `MASUMI_ESCROW_UNIT` (Task 15).
2. **Escrow deadlines the node rejects, or a refund that takes longer than the demo expects.** `submitResultTime` < now+15 min, or `payByTime` within 5 min of it, is a 400. A refund needs submit+10 min + one batch. *Check:* `createPaymentRequest` validates before calling (Task 11 test "rejects deadlines the node would refuse"). The escrow E2E records real timestamps for FundsLocked → RefundWithdrawn (Tasks 6, 15). The demo script uses those numbers.
3. **The wrong result hash shape.** The skill docs say `inputHash+outputHash` (128 hex). The node accepts only a 64-hex sha256, so the seller is never paid and the buyer is auto-refunded. *Check:* `submitResult` rejects anything but 64 hex with a message naming the cause (Task 11 test "rejects a 128-hex input+output hash"). The live pass run reaches `ResultSubmitted` (Task 15).
4. **The registry shows the agent Offline or Invalid although it is up.** Causes: http or trailing-slash `apiBaseUrl` (the registry appends `/availability`), a redirect (it uses `redirect:'manual'`), or `/availability` returning an `agentIdentifier` that differs from the NFT. Invalid is sticky because the periodic job never re-checks Invalid. *Check:* `registerAgent` rejects http and trailing `/` (Task 10 test). Task 17 step 3 runs `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}'` on `/availability`, expecting `200` and an empty redirect, and checks the body has `type:"masumi-agent"` and no `agentIdentifier`. `register-e2e` fails loudly on `Invalid` (Task 14).
5. **Escrow earnings land in the platform wallet, not the seller's (an undisclosed custody change).** Without `sellerReturnAddress`, V2 collection goes to the selling hot wallet's collection address. *Check:* `createPaymentRequest` forwards `sellerReturnAddress` (Task 11 test "forwards sellerReturnAddress…"). `createPurchase` copies the signed value (Task 12 test). Task 6 step 5 checks the seller address's Masumi tUSDM balance on Blockfrost goes up by 95% of the price after unlock.

## Contract deltas P4 proposes (additive; tell all owners at the hour-2 post)

1. `MasumiConfig` gains optional `registryUrl?: string; registryToken?: string`. New env vars `REGISTRY_SERVICE_URL` (default `https://registry.masumi.network/api/v1`) and `REGISTRY_API_KEY`. `getRegistryStatus` needs them: the managed registry rejects requests without a token.
2. `createPaymentRequest` gains optional `sellerReturnAddress?: string`. The gateway should pass the seller's verified `sellers.cardano_addr` so escrow pays the seller directly (spec §6.2 step 5 answered: **yes**).
3. New export `refreshRegistryStatus(c, agentIdentifier)`. It forces the registry to re-check now, so the demo "registry Offline" moment and the coworker's "wait for Online" don't depend on the 50-entry rotation.
4. Timing facts for P1's `start_job`: send `payByTime = now+10 min` and `submitResultTime = now+20 min`. A buyer must lock within 5 min of `start_job`, or `/purchase` rejects the 15-min rule. Auto-refund arrives about 31–35 min after `start_job`. The spec's "short `submitResultTime`" means 20 minutes.
5. `identifier_from_purchaser` must be 14–26 hex chars (node rule). The gateway must 400 anything else before calling `createPaymentRequest`.
6. Pin the MIP-003 `start_job` response field names that `escrow-e2e --gateway` reads: `job_id, blockchainIdentifier, payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime` (unix ms numbers), `agentIdentifier, sellerVKey, identifierFromPurchaser, input_hash`.
7. Each `apps/*` that runs on EC2 has a `start` script (`tsx src/index.ts`) and listens on `0.0.0.0`. New `.env` keys `PUBLIC_DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD` (compose interpolation).
8. Spec §5 correction: the **selling** wallet pays the registry mint, not the purchasing wallet.

---

## File Structure

```
docker-compose.yml                         # P4: postgres, payment-service, gateway, coworker, availability-stub, caddy
Caddyfile                                  # P4: TLS for PUBLIC_DOMAIN → gateway:4021, /spike/* → availability-stub
.env.example                               # P1-owned; P4 appends PUBLIC_DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD, REGISTRY_SERVICE_URL, REGISTRY_API_KEY
.gitignore                                 # P1-owned; P4 appends deploy/masumi.env
deploy/
  app.Dockerfile                           # generic pnpm-workspace runner for apps/gateway and apps/coworker
  app.Dockerfile.dockerignore              # BuildKit per-Dockerfile ignore
  masumi.env.example                       # payment-service runtime + seed env (real file deploy/masumi.env is gitignored)
  postgres-init/01-masumi-db.sql           # creates the `masumi` database on first boot
  ec2/user-data.sh                         # swap, jq, git, docker
  deploy.sh                                # rsync repo → EC2, compose up
  spike/availability-stub.mjs              # /availability with a file-flag 503 switch, logs every registry hit
  spike/escrow-spike.sh                    # curl-only escrow pass/fail spike (hours 0–2)
docs/spikes/p4-spike-results.md            # what the spike measured (posted to team chat at hour 2)
packages/masumi/
  package.json
  tsconfig.json
  src/types.ts                             # MasumiConfig, RegistryStatus, PaymentState
  src/errors.ts                            # MasumiApiError, MasumiInputError
  src/constants.ts                         # MASUMI_ESCROW_UNIT, timing offsets, registry default URL
  src/http.ts                              # fetch wrapper: token header, envelope, error redaction
  src/config.ts                            # masumiConfigFromEnv
  src/registry.ts                          # registerAgent, getAgentIdentifier, getRegistryStatus, refreshRegistryStatus
  src/payments.ts                          # createPaymentRequest, getPaymentState, submitResult, resolvePayment
  src/purchases.ts                         # createPurchase, getPurchaseState
  src/index.ts                             # public exports
  test/fakeFetch.ts                        # vi.stubGlobal fake server
  test/fixtures.ts                         # shared node payment-record fixture
  test/http.test.ts
  test/registry.test.ts
  test/payments.test.ts
  test/purchases.test.ts
  test/config.test.ts
  test/lib.test.ts
  scripts/env.ts                           # loads repo-root .env without overriding shell vars
  scripts/lib.ts                           # mip004, jcsFlat, intervalSeconds, parseStartJob
  scripts/smoke.ts                         # live, read-only preprod checks incl. live-spec field names
  scripts/register-e2e.ts                  # register → minted → Online
  scripts/measure-health.ts                # registry status/lastUptimeCheck sampler, --refresh
  scripts/escrow-e2e.ts                    # pass / fail (auto-refund), direct or via gateway start_job
```

---

### Task 1: Compose stack, Caddy, Dockerfile, stub and env templates (hour 0–0.3, laptop)

**Files:**
- Create: `docker-compose.yml`, `Caddyfile`, `deploy/app.Dockerfile`, `deploy/app.Dockerfile.dockerignore`, `deploy/masumi.env.example`, `deploy/postgres-init/01-masumi-db.sql`, `deploy/spike/availability-stub.mjs`
- Modify: `.env.example` (append), `.gitignore` (append)

**Interfaces:**
- Consumes: contract env names. `apps/gateway` and `apps/coworker` expose a `start` script (contract delta 7).
- Produces: compose service DNS names `postgres:5432`, `payment-service:3001`, `gateway:4021`, `availability-stub:8080`. Docker network `hirakumi_default`. Public routes `https://${PUBLIC_DOMAIN}/…` → gateway and `https://${PUBLIC_DOMAIN}/spike/availability` → stub.

- [ ] **Step 1: Check the repo is a git repo**

Run: `cd /Users/frederick/Documents/Projects/token2049 && (git rev-parse --show-toplevel || git init)`
Expected: prints `/Users/frederick/Documents/Projects/token2049` (or `Initialized empty Git repository`).

- [ ] **Step 2: Write `docker-compose.yml`**

```yaml
name: hirakumi

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: hirakumi
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-hirakumi}
      POSTGRES_DB: hirakumi
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./deploy/postgres-init:/docker-entrypoint-initdb.d:ro
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hirakumi -d hirakumi"]
      interval: 5s
      timeout: 3s
      retries: 30

  payment-service:
    image: ghcr.io/masumi-network/masumi-payment-service:0.29.0
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - deploy/masumi.env
    environment:
      DATABASE_URL: postgresql://hirakumi:${POSTGRES_PASSWORD:-hirakumi}@postgres:5432/masumi?schema=public&connection_limit=10
      PORT: "3001"
    ports:
      - "127.0.0.1:3001:3001"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3001/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 30

  gateway:
    build:
      context: .
      dockerfile: deploy/app.Dockerfile
      args:
        APP_DIR: apps/gateway
    restart: unless-stopped
    env_file:
      - path: .env
        required: false
    environment:
      DATABASE_URL: postgres://hirakumi:${POSTGRES_PASSWORD:-hirakumi}@postgres:5432/hirakumi
      PAYMENT_SERVICE_URL: http://payment-service:3001/api/v1
      GATEWAY_PORT: "4021"
    depends_on:
      postgres:
        condition: service_healthy
      payment-service:
        condition: service_healthy
    expose:
      - "4021"

  coworker:
    build:
      context: .
      dockerfile: deploy/app.Dockerfile
      args:
        APP_DIR: apps/coworker
    restart: unless-stopped
    env_file:
      - path: .env
        required: false
    environment:
      DATABASE_URL: postgres://hirakumi:${POSTGRES_PASSWORD:-hirakumi}@postgres:5432/hirakumi
      PAYMENT_SERVICE_URL: http://payment-service:3001/api/v1
    depends_on:
      postgres:
        condition: service_healthy
      payment-service:
        condition: service_healthy

  availability-stub:
    image: node:22-alpine
    restart: unless-stopped
    command: ["node", "/stub/availability-stub.mjs"]
    volumes:
      - ./deploy/spike:/stub:ro
      - stubflags:/flags
    expose:
      - "8080"

  caddy:
    image: caddy:2.11-alpine
    restart: unless-stopped
    environment:
      PUBLIC_DOMAIN: ${PUBLIC_DOMAIN:?set PUBLIC_DOMAIN in .env}
      ACME_EMAIL: ${ACME_EMAIL:?set ACME_EMAIL in .env}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  pgdata:
  caddy_data:
  caddy_config:
  stubflags:
```

- [ ] **Step 3: Write `Caddyfile`**

```
{
	email {$ACME_EMAIL}
}

{$PUBLIC_DOMAIN} {
	encode zstd gzip

	# Spike/operator tool: registry health-check measurement independent of the gateway.
	handle_path /spike/* {
		reverse_proxy availability-stub:8080
	}

	handle {
		reverse_proxy gateway:4021
	}

	log {
		output stdout
		format console
	}
}
```

- [ ] **Step 4: Write `deploy/spike/availability-stub.mjs`**

```js
// Stand-in for the gateway's MIP-003 /availability so the Masumi registry health
// check can be registered and timed before apps/gateway exists.
//   docker compose exec availability-stub touch /flags/down   -> 503
//   docker compose exec availability-stub rm -f /flags/down   -> 200
// Every request is logged with a timestamp, so the registry's check interval is
// the gap between consecutive registry hits in `docker compose logs availability-stub`.
import { createServer } from "node:http";
import { existsSync } from "node:fs";

const DOWN_FLAG = "/flags/down";
const PORT = 8080;

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://stub").pathname;
  const down = existsSync(DOWN_FLAG);
  const status = path !== "/availability" ? 404 : down ? 503 : 200;
  const from = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "-";
  console.log(`${new Date().toISOString()} ${req.method} ${path} from=${from} ua=${req.headers["user-agent"] ?? "-"} -> ${status}`);
  res.writeHead(status, { "content-type": "application/json" });
  if (status === 404) {
    res.end(JSON.stringify({ error: "not_found" }));
  } else if (status === 503) {
    res.end(JSON.stringify({ status: "unavailable", message: "spike stub is down", estimated_downtime_seconds: 60 }));
  } else {
    res.end(JSON.stringify({ status: "available", type: "masumi-agent", message: "spike stub is up" }));
  }
}).listen(PORT, "0.0.0.0", () => console.log(`availability stub listening on :${PORT}`));
```

- [ ] **Step 5: Write `deploy/app.Dockerfile` and its ignore file**

`deploy/app.Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
ARG APP_DIR
ENV APP_DIR=${APP_DIR} NODE_ENV=production
CMD ["sh", "-c", "exec pnpm -C \"$APP_DIR\" start"]
```

`deploy/app.Dockerfile.dockerignore`:

```
**/node_modules
.git
.env
.env.*
!.env.example
deploy/masumi.env
apps/web/.next
vendor
docs
```

- [ ] **Step 6: Write `deploy/postgres-init/01-masumi-db.sql`**

```sql
-- Runs once, on an empty pgdata volume. The payment service gets its own database.
CREATE DATABASE masumi OWNER hirakumi;
```

- [ ] **Step 7: Write `deploy/masumi.env.example`**

```
# Masumi payment service 0.29.0: runtime + seed env. Copy to deploy/masumi.env (gitignored), chmod 600.
# Do NOT copy the upstream .env.example verbatim: its PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD /
# REGISTRY_POLICY_ID_PREPROD placeholders would override the real preprod contracts.

# openssl rand -hex 32
ENCRYPTION_KEY=
# openssl rand -hex 24  (this value is the admin API token = PAYMENT_SERVICE_TOKEN in the root .env)
ADMIN_KEY=
# same value as BLOCKFROST_PROJECT_ID in the root .env (preprod project)
BLOCKFROST_API_KEY_PREPROD=
# Leave both blank: the seed generates them and prints them ONCE. Save them in the team password manager.
PURCHASE_WALLET_PREPROD_MNEMONIC=
SELLING_WALLET_PREPROD_MNEMONIC=
# Platform collection address (operator's Eternl, addr_test1…). Used only when a payment has no sellerReturnAddress.
COLLECTION_WALLET_PREPROD_ADDRESS=
SEED_ONLY_IF_EMPTY=true

# Demo-speed schedulers (code minimum is 5 s). Upstream .env.example uses 180–300 s.
BLOCK_CONFIRMATIONS_THRESHOLD=1
BATCH_PAYMENT_INTERVAL=10
CHECK_TX_INTERVAL=15
CHECK_COLLECTION_INTERVAL=15
CHECK_COLLECT_REFUND_INTERVAL=15
CHECK_SET_REFUND_INTERVAL=15
CHECK_UNSET_REFUND_INTERVAL=15
CHECK_AUTHORIZE_REFUND_INTERVAL=15
CHECK_AUTHORIZE_WITHDRAWAL_INTERVAL=15
CHECK_SUBMIT_RESULT_INTERVAL=15
CHECK_WALLET_TRANSACTION_HASH_INTERVAL=20
REGISTER_AGENT_INTERVAL=15
DEREGISTER_AGENT_INTERVAL=15
CHECK_REGISTRY_TRANSACTIONS_INTERVAL=15
AUTO_DECISION_INTERVAL=15
AUTO_WITHDRAW_PAYMENTS=true
AUTO_WITHDRAW_REFUNDS=true
```

- [ ] **Step 8: Append to `.env.example` and `.gitignore`**

Append to `.env.example` under `# masumi payment service`:

```
REGISTRY_SERVICE_URL=https://registry.masumi.network/api/v1
# managed registry token (Task 5 step 1); empty → registry status checks are skipped
REGISTRY_API_KEY=
# deploy (docker compose interpolation)
# host part of PUBLIC_BASE_URL
PUBLIC_DOMAIN=api.hirakumi.app
ACME_EMAIL=ops@hirakumi.app
POSTGRES_PASSWORD=hirakumi
```

Append to `.gitignore`:

```
deploy/masumi.env
```

- [ ] **Step 9: Validate the compose file**

Run: `cd /Users/frederick/Documents/Projects/token2049 && cp deploy/masumi.env.example deploy/masumi.env && PUBLIC_DOMAIN=api.example.test ACME_EMAIL=a@example.test docker compose config --services`
Expected (order may vary): `postgres`, `payment-service`, `gateway`, `coworker`, `availability-stub`, `caddy`. Then `rm deploy/masumi.env`.

Run: `node --check deploy/spike/availability-stub.mjs && echo ok`
Expected: `ok`

- [ ] **Step 10: Commit**

```bash
git add docker-compose.yml Caddyfile deploy/ .env.example .gitignore
git commit -m "feat(deploy): compose stack, Caddy TLS proxy, payment-service env, availability stub" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: AWS EC2 (ap-southeast-1), Elastic IP, DNS, Docker (hour 0–0.5)

**Files:**
- Create: `deploy/ec2/user-data.sh`, `deploy/deploy.sh`

**Interfaces:**
- Consumes: an AWS account with CLI v2 credentials (`aws sts get-caller-identity` works). A domain you control (contract default `api.hirakumi.app`).
- Produces: shell vars `IID`, `SG`, `ALLOC`, `EIP` (record them in `docs/spikes/p4-spike-results.md`). Host `ubuntu@$EIP` with Docker and `/opt/hirakumi`. DNS `A api.<domain> → $EIP`.

- [ ] **Step 1: Write `deploy/ec2/user-data.sh`**

```bash
#!/bin/bash
set -euxo pipefail
# 4 GB swap: pnpm install of the payment-service checkout (Task 3) is memory hungry.
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
apt-get update -y
apt-get install -y jq git rsync
curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu
systemctl enable --now docker
mkdir -p /opt/hirakumi
chown ubuntu:ubuntu /opt/hirakumi
```

- [ ] **Step 2: Write `deploy/deploy.sh`**

```bash
#!/usr/bin/env bash
# Usage (from the repo root on a laptop): EIP=<elastic ip> deploy/deploy.sh [service ...]
# Syncs the repo (never .env or deploy/masumi.env) and runs docker compose up for the given services (all if none).
set -euo pipefail
: "${EIP:?set EIP to the instance Elastic IP}"
KEY=${KEY:-$HOME/.ssh/hirakumi.pem}
cd "$(dirname "$0")/.."
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .env --exclude deploy/masumi.env \
  --exclude 'apps/web/.next' --exclude vendor \
  -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" ./ "ubuntu@$EIP:/opt/hirakumi/"
ssh -i "$KEY" "ubuntu@$EIP" "cd /opt/hirakumi && docker compose up -d --build --remove-orphans $* && docker compose ps"
```

Run: `chmod +x deploy/deploy.sh deploy/ec2/user-data.sh`

- [ ] **Step 3: Provision the instance**

```bash
export AWS_REGION=ap-southeast-1
AMI=$(aws ssm get-parameters --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query 'Parameters[0].Value' --output text)
aws ec2 create-key-pair --key-name hirakumi --key-type ed25519 --query KeyMaterial --output text > ~/.ssh/hirakumi.pem
chmod 600 ~/.ssh/hirakumi.pem
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 create-security-group --group-name hirakumi-sg --description "Hirakumi: 22 team IPs, 80/443 public" --vpc-id "$VPC" --query GroupId --output text)
MYIP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$MYIP/32"
aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol udp --port 443 --cidr 0.0.0.0/0
IID=$(aws ec2 run-instances --image-id "$AMI" --instance-type t3.large --key-name hirakumi \
  --security-group-ids "$SG" \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=40,VolumeType=gp3}' \
  --metadata-options HttpTokens=required \
  --user-data file://deploy/ec2/user-data.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=hirakumi}]' \
  --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --instance-ids "$IID"
ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
aws ec2 associate-address --instance-id "$IID" --allocation-id "$ALLOC"
EIP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
echo "IID=$IID SG=$SG ALLOC=$ALLOC EIP=$EIP"
```

To add a teammate's SSH IP later, run: `aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr <their-ip>/32`

Console equivalent: EC2 → Launch instance. Ubuntu Server 24.04 LTS (x86), t3.large, key pair `hirakumi`, a new security group with SSH from "My IP" and HTTP/HTTPS from anywhere, 40 GiB gp3. Advanced → User data: paste `deploy/ec2/user-data.sh`. Then Elastic IPs → Allocate → Associate with the instance.

- [ ] **Step 4: DNS A record**

If the zone is in Route 53:

```bash
DOMAIN=hirakumi.app
ZONE=$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN" --query 'HostedZones[0].Id' --output text)
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"api.$DOMAIN\",\"Type\":\"A\",\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"$EIP\"}]}}]}"
```

Elsewhere: at the registrar, add `A  api  <EIP>  TTL 60`. If the team doesn't own `hirakumi.app`, use any domain it controls and set `PUBLIC_BASE_URL=https://api.<that domain>` and `PUBLIC_DOMAIN=api.<that domain>` for everyone. Last resort (unverified: the Let's Encrypt issuance rate for shared wildcard-DNS domains may fail): `PUBLIC_DOMAIN=api.<EIP with dots>.sslip.io`.

- [ ] **Step 5: Verify host and DNS**

Run: `dig +short api.hirakumi.app @1.1.1.1`
Expected: the `$EIP` value.

Run: `ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP 'cloud-init status --wait && docker compose version && jq --version && swapon --show --noheadings'`
Expected: `status: done`, `Docker Compose version v2.x`, `jq-1.7…`, and a `/swapfile file 4G` line.

- [ ] **Step 6: Commit**

```bash
git add deploy/ec2/user-data.sh deploy/deploy.sh
git commit -m "feat(deploy): EC2 user-data and rsync deploy script" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bring up Postgres, the payment service (migrate + seed), the stub and Caddy (hour 0.5–1)

**Files:**
- Server only: `/opt/hirakumi/.env`, `/opt/hirakumi/deploy/masumi.env`, `/opt/masumi-src` (checkout of tag 0.29.0)

**Interfaces:**
- Consumes: Task 1 files, Task 2 host, Blockfrost preprod project id.
- Produces: `PAYMENT_SERVICE_TOKEN` (= `ADMIN_KEY`), the selling and purchasing wallet addresses and mnemonics (password manager), and `https://$PUBLIC_DOMAIN/spike/availability` with a valid certificate.

- [ ] **Step 1: Create the secrets locally and copy them**

```bash
cp deploy/masumi.env.example /tmp/masumi.env
sed -i '' "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$(openssl rand -hex 32)/; s/^ADMIN_KEY=.*/ADMIN_KEY=$(openssl rand -hex 24)/" /tmp/masumi.env
# edit /tmp/masumi.env: BLOCKFROST_API_KEY_PREPROD=<preprod project id>, COLLECTION_WALLET_PREPROD_ADDRESS=<operator Eternl addr_test1…>
cp .env.example /tmp/hirakumi.env
# edit /tmp/hirakumi.env: PUBLIC_BASE_URL, PUBLIC_DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD=$(openssl rand -hex 16),
#   PAYMENT_SERVICE_TOKEN=<ADMIN_KEY from /tmp/masumi.env>, BLOCKFROST_PROJECT_ID, INTERNAL_TOKEN=$(openssl rand -hex 32)
EIP=<elastic ip> deploy/deploy.sh postgres
scp -i ~/.ssh/hirakumi.pem /tmp/masumi.env ubuntu@$EIP:/opt/hirakumi/deploy/masumi.env
scp -i ~/.ssh/hirakumi.pem /tmp/hirakumi.env ubuntu@$EIP:/opt/hirakumi/.env
ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP 'chmod 600 /opt/hirakumi/.env /opt/hirakumi/deploy/masumi.env'
rm /tmp/masumi.env /tmp/hirakumi.env
```

The first `deploy.sh postgres` fails at compose interpolation if `.env` is not there yet. That is expected: it only syncs the files. Run it again after the `scp`: `EIP=$EIP deploy/deploy.sh postgres`.

- [ ] **Step 2: Verify Postgres has both databases**

Run: `ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP "cd /opt/hirakumi && docker compose exec -T postgres psql -U hirakumi -tAc \"select datname from pg_database where datname in ('hirakumi','masumi') order by 1\""`
Expected:
```
hirakumi
masumi
```

- [ ] **Step 3: Check out the payment service source at the image's tag**

Run: `ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP 'sudo git clone --depth 1 --branch 0.29.0 https://github.com/masumi-network/masumi-payment-service.git /opt/masumi-src && sudo chown -R ubuntu:ubuntu /opt/masumi-src && git -C /opt/masumi-src log -1 --format=%H'`
Expected: `71455701ac22c3380c50da54089e1b7363f6825d`

- [ ] **Step 4: Migrate and seed (prints the wallet mnemonics once)**

```bash
ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP 'cd /opt/hirakumi && POSTGRES_PASSWORD=$(grep -E "^POSTGRES_PASSWORD=" .env | cut -d= -f2- | sed -E "s/[[:space:]]+#.*$//") && \
  docker run --rm --network hirakumi_default --env-file deploy/masumi.env \
    -e DATABASE_URL="postgresql://hirakumi:${POSTGRES_PASSWORD}@postgres:5432/masumi?schema=public" \
    -v /opt/masumi-src:/src -w /src node:20-bookworm \
    bash -c "corepack enable && pnpm install --frozen-lockfile && pnpm run prisma:migrate && pnpm run prisma:seed" \
  > ~/masumi-seed.log 2>&1; echo exit=$?; chmod 600 ~/masumi-seed.log; grep -E "Contract seeded on preprod|ADMIN_KEY seeded|mnemonic|Error" ~/masumi-seed.log | sed -E "s/([a-z]+ ){23}[a-z]+/<24 words redacted>/"'
```

Expected: `exit=0`, `Contract seeded on preprod: addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g added. Registry policyId: 67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b`, `ADMIN_KEY seeded successfully`.

Then copy the two printed mnemonics into the team password manager: `ssh … 'less ~/masumi-seed.log'`. After that, remove the log: `ssh … 'shred -u ~/masumi-seed.log'`.

If `pnpm install` fails with an out-of-memory kill (`exit=137`), check swap is on (`swapon --show`) and run the step again. Migrations are idempotent, and `SEED_ONLY_IF_EMPTY=true` makes the seed idempotent.

- [ ] **Step 5: Start the payment service, the stub and Caddy**

Run: `EIP=$EIP deploy/deploy.sh postgres payment-service availability-stub caddy`
Expected: all four services `running`, and `payment-service` becomes `(healthy)` within 2 minutes.

- [ ] **Step 6: Verify the admin token, the V2 source and the wallets**

```bash
ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP 'cd /opt/hirakumi && set -a && . deploy/masumi.env && set +a && PS=http://127.0.0.1:3001/api/v1 && \
  curl -s $PS/health | jq -c .data && \
  curl -s $PS/api-key-status -H "token: $ADMIN_KEY" | jq -c .status && \
  curl -s "$PS/payment-source?take=10" -H "token: $ADMIN_KEY" | jq -c ".data.PaymentSources[] | {network,paymentSourceType,smartContractAddress}" && \
  curl -s "$PS/wallet/list?take=10" -H "token: $ADMIN_KEY" | jq -c ".data.Wallets[] | {type,walletVkey,walletAddress,collectionAddress}"'
```

Expected:
- `{"status":"ok"}` and `"success"`;
- a source `{"network":"Preprod","paymentSourceType":"Web3CardanoV2","smartContractAddress":"addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g"}`;
- one `Selling` and one `Purchasing` wallet, each with `addr_test1…` and a 56-hex `walletVkey`.

Record both addresses in `docs/spikes/p4-spike-results.md`.

- [ ] **Step 7: Verify TLS, the stub, and that the admin port is not public**

Run: `curl -sS https://api.hirakumi.app/spike/availability`
Expected: `{"status":"available","type":"masumi-agent","message":"spike stub is up"}`

Run: `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://api.hirakumi.app/spike/availability`
Expected: `200 ` (empty redirect).

Run: `nc -vz -w 5 $EIP 3001; nc -vz -w 5 $EIP 5432`
Expected: both time out or are refused (bound to 127.0.0.1 and blocked by the security group).

Admin UI for humans: `ssh -i ~/.ssh/hirakumi.pem -N -L 3001:127.0.0.1:3001 ubuntu@$EIP`, then open http://localhost:3001/admin and log in with `ADMIN_KEY`.

---

### Task 4: Wallet funding runbook (hour 0.5–1, runs in parallel with Task 3 step 4)

**Files:** none (results go into `docs/spikes/p4-spike-results.md` in Task 8)

**Interfaces:**
- Consumes: the wallet addresses from Task 3 step 6, `BUYER_MNEMONIC` / `SELLER_DEMO_ADDRESS` from P5.
- Produces: funded wallets meeting the minimums below (checked again by `smoke` in Task 13).

| Wallet | Keys held by | Minimum | Why | Source |
|---|---|---|---|---|
| Node **selling** wallet | payment service (encrypted) | **100 tADA** | Pays every registry mint (~2 tADA tx + min-UTxO held with each NFT), submit-result and collection fees, script collateral | Cardano faucet (Preprod) |
| Node **purchasing** wallet (demo escrow buyer) | payment service | **100 tADA + 10 Masumi tUSDM** (`16a55b2a…0014df10745553444d`) | Locks escrow for each E2E job (price + min-UTxO + fees) | Cardano faucet + https://dispenser.masumi.network |
| Demo pack buyer (`BUYER_MNEMONIC`, P5) | `agents/buyer` | **50 tADA + 10 x402 tUSDM** (`e675b46e…`) | x402 pack purchases (min-UTxO ~1.4 tADA each) | Cardano faucet + https://tusdm.moneta.global |
| Seller demo wallet (`SELLER_DEMO_ADDRESS`, Mika's Eternl) | Eternl | **10 tADA** | Address exists on chain; receives x402 packs and escrow payouts | Cardano faucet |
| Platform collection (`COLLECTION_WALLET_PREPROD_ADDRESS`) | operator Eternl | 0 | Fallback payout when a payment has no `sellerReturnAddress` | — |

- [ ] **Step 1: Request tADA** at https://docs.cardano.org/cardano-testnets/tools/faucet. Choose network **Preprod** and paste each address above, one request per address. The faucet is rate-limited per address. If it refuses, use the Masumi dispenser https://dispenser.masumi.network, which also sends tADA.
- [ ] **Step 2: Request Masumi tUSDM** at https://dispenser.masumi.network for the **purchasing** wallet address. Before using the token, confirm the received policy id is `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde` (step 4).
- [ ] **Step 3: Request x402 tUSDM** at https://tusdm.moneta.global for the pack buyer address (P5's wallet; P4 runs this if P5 is busy).
- [ ] **Step 4: Verify every balance by exact unit**

```bash
BF=<BLOCKFROST_PROJECT_ID>
for A in <selling> <purchasing> <pack-buyer> <seller-demo>; do
  curl -s -H "project_id: $BF" "https://cardano-preprod.blockfrost.io/api/v0/addresses/$A" \
  | jq -c --arg a "$A" '{addr: $a[0:20], tADA: ((.amount[]? | select(.unit=="lovelace") | .quantity | tonumber) / 1e6),
      masumi_tUSDM: ([.amount[]? | select(.unit=="16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d") | .quantity | tonumber][0] // 0) / 1e6,
      x402_tUSDM: ([.amount[]? | select(.unit=="e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d") | .quantity | tonumber][0] // 0) / 1e6}'
done
```

Expected: every row meets the minimum in the table. The purchasing wallet shows `masumi_tUSDM ≥ 10` and `x402_tUSDM: 0`. The pack buyer shows `x402_tUSDM ≥ 10`. A `null` tADA row means the address is unused: the faucet transaction has not landed yet, so wait one minute and run it again.

---

### Task 5: Spike S1: registry registration, Online, 503 → Offline, health-check interval (hour 1–2)

**Files:** none new. Uses the curl API on the EC2 host.

**Interfaces:**
- Consumes: the funded selling wallet, `https://$PUBLIC_DOMAIN/spike` (stub).
- Produces: `SPIKE_AGENT_ID` (120 hex). Records: mint duration, time to first Online, the stub-observed registry hit interval, and the times for touch-down → Offline (passive and refresh).

- [ ] **Step 1: Get a registry token (start at minute 0, it is a human dependency)**

Ask in the Masumi Discord (https://discord.com/invite/aj4QfnTS92, dev channel) or at the Masumi hackathon desk for a **preprod `REGISTRY_API_KEY` for `https://registry.masumi.network/api/v1`**. Put it in the laptop `.env` and the server `/opt/hirakumi/.env`.

Verify: `curl -s -X POST https://registry.masumi.network/api/v1/registry-entry/ -H "token: $REGISTRY_API_KEY" -H 'content-type: application/json' -d '{"network":"Preprod","limit":1}' | jq -r .status`
Expected: `success` (without a key: `{"status":"error","error":{"message":"No token provided"}}`).

- [ ] **Step 2: Register the spike agent (curl, on the host)**

```bash
ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP
cd /opt/hirakumi && set -a && . deploy/masumi.env && set +a
# read single keys from the root .env (it holds unquoted mnemonics, so never `source` it)
envget() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//'; }
PUBLIC_DOMAIN=$(envget PUBLIC_DOMAIN); REGISTRY_API_KEY=$(envget REGISTRY_API_KEY)
PS=http://127.0.0.1:3001/api/v1; H="token: $ADMIN_KEY"
UNIT=16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d
SELL_VKEY=$(curl -s "$PS/wallet/list?walletType=Selling&take=1" -H "$H" | jq -r '.data.Wallets[0].walletVkey')
ESCROW=$(curl -s "$PS/payment-source?take=10" -H "$H" | jq -r '.data.PaymentSources[] | select(.paymentSourceType=="Web3CardanoV2" and .network=="Preprod") | .smartContractAddress')
jq -n --arg vk "$SELL_VKEY" --arg esc "$ESCROW" --arg unit "$UNIT" --arg url "https://$PUBLIC_DOMAIN/spike" \
 '{network:"Preprod", sellingWalletVkey:$vk, name:"Hirakumi spike agent", description:"Spike: availability stub for registry health-check timing",
   apiBaseUrl:$url, Tags:["hirakumi","spike"], ExampleOutputs:[], Capability:{name:"hirakumi-openapi-wrapper",version:"1"},
   Author:{name:"Hirakumi"},
   supportedPaymentSources:[{chain:"Cardano",network:"Preprod",paymentSourceType:"Web3CardanoV2",address:$esc,
     pricing:{pricingType:"Fixed",fixed:[{asset:$unit,amount:"1000000"}]}}]}' > /tmp/reg.json
date -u +%FT%TZ; curl -s -X POST $PS/registry -H "$H" -H 'content-type: application/json' -d @/tmp/reg.json | tee /tmp/reg-res.json | jq -c '{status, id: .data.id, state: .data.state, error: (.error.message // .data.error)}'
```

Expected: `{"status":"success","id":"<cuid>","state":"RegistrationRequested","error":null}`. If you get a 400, record the exact `error.message`: it names the field. The live spec at `http://127.0.0.1:3001/api-docs` is authoritative: `curl -s http://127.0.0.1:3001/api-docs | jq '.paths["/api/v1/registry"].post.requestBody.content["application/json"].schema' | head -80`.

- [ ] **Step 3: Wait for the mint and record its duration**

Run: `watch -n 15 "curl -s '$PS/registry?network=Preprod&filterPaymentSourceType=Web3CardanoV2&limit=20' -H '$H' | jq -c '.data.Assets[] | select(.name==\"Hirakumi spike agent\") | {state,agentIdentifier,error}'"`
Expected: `RegistrationRequested` → `RegistrationInitiated` → `RegistrationConfirmed`, with `agentIdentifier` (120 hex starting `67ab0c92…`). Record the minutes from step 2's timestamp, and `export SPIKE_AGENT_ID=<agentIdentifier>`.

- [ ] **Step 4: Watch the registry hit the stub (direct interval measurement)**

Run (leave it open): `cd /opt/hirakumi && docker compose logs -f --since 1m availability-stub | grep --line-buffered /availability`
Expected: lines like `2026-10-06T…Z GET /availability from=<registry ip> ua=node -> 200`. Record each registry hit timestamp. The interval is the gap between consecutive hits from the same `from` IP. Wait for at least 3 hits, or 30 minutes, whichever comes first. If no hit arrives within 30 minutes of `RegistrationConfirmed`, record "no direct hit observed in 30 min" and rely on step 5.

- [ ] **Step 5: Read status and force a check (needs REGISTRY_API_KEY)**

```bash
REG=https://registry.masumi.network/api/v1; RH="token: $REGISTRY_API_KEY"
curl -s -X POST $REG/registry-entry/ -H "$RH" -H 'content-type: application/json' \
  -d "{\"network\":\"Preprod\",\"filter\":{\"assetIdentifier\":\"$SPIKE_AGENT_ID\"},\"limit\":1}" | jq -c '.data.entries[0] | {status,lastUptimeCheck}'
curl -s -X POST $REG/registry-entry-refresh/ -H "$RH" -H 'content-type: application/json' \
  -d "{\"network\":\"Preprod\",\"agentIdentifier\":\"$SPIKE_AGENT_ID\"}" | jq -c '.data.entry | {status,lastUptimeCheck}'
```

Expected: the first call shows the cached status (possibly not indexed yet → `null`). After the refresh: `{"status":"Online","lastUptimeCheck":"<just now>"}`, and the stub log shows a hit at that second. Record the time from `RegistrationConfirmed` to the first `Online`.

- [ ] **Step 6: Flip to 503 and measure**

```bash
date -u +%FT%TZ; docker compose exec availability-stub touch /flags/down
curl -s -o /dev/null -w '%{http_code}\n' https://$PUBLIC_DOMAIN/spike/availability     # expect 503
# passive: poll every 15 s until the cached status says Offline (max 30 min)
for i in $(seq 1 120); do S=$(curl -s -X POST $REG/registry-entry/ -H "$RH" -H 'content-type: application/json' \
  -d "{\"network\":\"Preprod\",\"filter\":{\"assetIdentifier\":\"$SPIKE_AGENT_ID\"},\"limit\":1}" | jq -r '.data.entries[0].status'); \
  echo "$(date -u +%T) $S"; [ "$S" = Offline ] && break; sleep 15; done
```

Expected: `503`, then a line with `Offline`. Record the passive time from touch-down to Offline. Then measure the forced path: `docker compose exec availability-stub rm -f /flags/down`, wait until refresh shows Online again, then `touch /flags/down` and run the refresh call from step 5 at once. Expected: `"status":"Offline"` in that response. Record the seconds (should be under 35).

Finally restore: `docker compose exec availability-stub rm -f /flags/down` and refresh → `Online`.

If there is no `REGISTRY_API_KEY`: run step 6 with the stub log only. Record when the next registry hit after touch-down returned 503. Check the agent's status manually at https://www.masumi.network/agent-explorer (unverified that it shows preprod; record what it shows).

---

### Task 6: Spike S2: escrow pass, no-submit auto-refund, collection to the seller's address (hour 1–2, ~40 min wall clock, background)

**Files:**
- Create: `deploy/spike/escrow-spike.sh`

**Interfaces:**
- Consumes: `SPIKE_AGENT_ID` (Task 5), a funded purchasing wallet, `SELLER_DEMO_ADDRESS`.
- Produces: `spike-escrow-pass.log` and `spike-escrow-fail.log` on the host, with a timestamp for every state change.

- [ ] **Step 1: Write `deploy/spike/escrow-spike.sh`**

```bash
#!/usr/bin/env bash
# curl-only escrow spike on the EC2 host. Same node = seller (selling wallet) and demo buyer (purchasing wallet).
# Usage: deploy/spike/escrow-spike.sh <pass|fail> <agentIdentifier> [sellerReturnAddress]
set -euo pipefail
MODE=${1:?pass|fail}; AGENT=${2:?agentIdentifier}; SELLER_RETURN=${3:-}
cd "$(dirname "$0")/../.."
set -a; . deploy/masumi.env; set +a
PS=http://127.0.0.1:3001/api/v1
LOG="spike-escrow-$MODE.log"
api() { curl -sS -X "$1" "$PS$2" -H "token: $ADMIN_KEY" -H 'content-type: application/json' ${3:+-d "$3"}; }
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
iso() { date -u -d "+$1 min" +%Y-%m-%dT%H:%M:%S.000Z; }

PID=$(openssl rand -hex 10)                       # 20 hex: node accepts 14–26
INPUT='{"symbol":"ADA"}'                          # flat ASCII object: JSON.stringify == JCS
IH=$(printf '%s;%s' "$PID" "$INPUT" | sha256sum | cut -d' ' -f1)
BODY=$(jq -n --arg a "$AGENT" --arg ih "$IH" --arg pid "$PID" --arg pb "$(iso 10)" --arg sr "$(iso 20)" \
  --arg ul "$(iso 36)" --arg ed "$(iso 52)" --arg ret "$SELLER_RETURN" \
  '{network:"Preprod",agentIdentifier:$a,inputHash:$ih,identifierFromPurchaser:$pid,paymentSourceType:"Web3CardanoV2",
    supportedPaymentSourceIndex:0,payByTime:$pb,submitResultTime:$sr,unlockTime:$ul,externalDisputeUnlockTime:$ed}
   + (if $ret == "" then {} else {sellerReturnAddress:$ret} end)')
api POST /payment "$BODY" > "pay-$PID.json"
jq -e '.status=="success"' "pay-$PID.json" > /dev/null || { cat "pay-$PID.json"; exit 1; }
BC=$(jq -r .data.blockchainIdentifier "pay-$PID.json")
log "payment created pid=$PID payBy=$(jq -r .data.payByTime pay-$PID.json) submitResult=$(jq -r .data.submitResultTime pay-$PID.json) unlock=$(jq -r .data.unlockTime pay-$PID.json) sellerReturnAddress=$(jq -r .data.sellerReturnAddress pay-$PID.json) RequestedFunds=$(jq -c .data.RequestedFunds pay-$PID.json)"

PURCHASE=$(jq --arg pid "$PID" '.data | {network:"Preprod",blockchainIdentifier,paymentSourceType:"Web3CardanoV2",
  smartContractAddress:.PaymentSource.smartContractAddress,supportedPaymentSourceIndex:0,inputHash,
  sellerVkey:.SmartContractWallet.walletVkey,agentIdentifier,payByTime,submitResultTime,unlockTime,externalDisputeUnlockTime,
  identifierFromPurchaser:$pid,sellerReturnAddress} | with_entries(select(.value != null))' "pay-$PID.json")
api POST /purchase "$PURCHASE" > "pur-$PID.json"
jq -e '.status=="success"' "pur-$PID.json" > /dev/null || { cat "pur-$PID.json"; exit 1; }
log "purchase created id=$(jq -r .data.id pur-$PID.json)"

state() { api POST "/$1/resolve-blockchain-identifier" "$(jq -n --arg bc "$BC" '{network:"Preprod",blockchainIdentifier:$bc}')" \
  | jq -r '[(.data.onChainState // "null"), .data.NextAction.requestedAction, (.data.NextAction.errorNote // "")] | join(" ")'; }
SUBMITTED=0; LAST=""
while true; do
  P=$(state payment); B=$(state purchase)
  [ "$P|$B" != "$LAST" ] && log "payment: $P | purchase: $B"; LAST="$P|$B"
  if [ "$MODE" = pass ] && [ "$SUBMITTED" = 0 ] && [[ "$P" == FundsLocked* ]]; then
    OUT='{"price":"0.42","symbol":"ADA"}'
    RH=$(printf '%s;%s' "$PID" "$OUT" | sha256sum | cut -d' ' -f1)   # MIP-004 output hash, 64 hex
    log "submit-result: $(api POST /payment/submit-result "$(jq -n --arg bc "$BC" --arg rh "$RH" '{network:"Preprod",blockchainIdentifier:$bc,submitResultHash:$rh}')" | jq -c '[.status, .data.NextAction.requestedAction, .error.message]')"
    SUBMITTED=1
  fi
  case "$P" in Withdrawn*|RefundWithdrawn*) log "terminal: $P"; break ;; esac
  case "$B" in RefundWithdrawn*) log "terminal (buyer): $B"; break ;; esac
  sleep 20
done
```

Run: `chmod +x deploy/spike/escrow-spike.sh && bash -n deploy/spike/escrow-spike.sh && echo ok` → `ok`. Commit it with the Task 8 record.

- [ ] **Step 2: Start the fail run first (it takes longest), then the pass run**

```bash
EIP=$EIP deploy/deploy.sh availability-stub     # syncs the new script
ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP "cd /opt/hirakumi && nohup deploy/spike/escrow-spike.sh fail $SPIKE_AGENT_ID > /dev/null 2>&1 &"
ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP "cd /opt/hirakumi && nohup deploy/spike/escrow-spike.sh pass $SPIKE_AGENT_ID <SELLER_DEMO_ADDRESS> > /dev/null 2>&1 &"
ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP 'cd /opt/hirakumi && tail -n 5 spike-escrow-fail.log spike-escrow-pass.log'
```

Expected within 1 minute: both logs show `payment created …` and `purchase created id=…`.
- A 400 that names a time field means the ISO `ez.dateIn` format failed. Record the message and switch `iso()` to `date -u -d "+$1 min" +%Y-%m-%dT%H:%M:%SZ`.
- A 400 `Invalid blockchain identifier, …` means the purchase terms differ from the signed ones. Record the message.

- [ ] **Step 3: Verify FundsLocked (both runs)**

Expected within ~1–5 min: `payment: FundsLocked WaitingForExternalAction | purchase: FundsLocked …`. Record the minutes from creation. Cross-check on chain: open `https://preprod.cardanoscan.io/address/addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`, where the newest tx carries 1 Masumi tUSDM.

- [ ] **Step 4: Verify the pass path**

Expected in `spike-escrow-pass.log`:
- `submit-result: ["success","SubmitResultRequested",null]`;
- then `payment: ResultSubmitted …`;
- after `unlockTime` (~36 min after creation) plus one collection batch: `payment: Withdrawn …` and `terminal: Withdrawn`.

Record each timestamp.

- [ ] **Step 5: Verify collection went to the seller's address (custody question, spec §6.2.5)**

Run Task 4 step 4's balance command for `SELLER_DEMO_ADDRESS` before step 2 and again after `terminal: Withdrawn`.
Expected: `masumi_tUSDM` goes up by **0.95** (1 tUSDM minus Masumi's 5%). Record **YES: collection goes straight to `sellerReturnAddress`**. If it does not go up, check whether the platform collection address or the selling wallet went up instead, and record **NO** plus where the funds landed. P1 then shows the "manual sweep" disclosure from the spec.

- [ ] **Step 6: Verify the auto-refund (fail path)**

Expected in `spike-escrow-fail.log`: `FundsLocked` stays until `submitResultTime + 10 min` (~30 min after creation). Then the purchase side moves to a withdraw-refund action, then `RefundWithdrawn`, then `terminal…`. Record the minutes from `submitResultTime` to `RefundWithdrawn`. The purchasing wallet's Masumi tUSDM returns to its pre-run value, minus nothing in tUSDM; tADA fees are spent.

---

### Task 7: Spike S3: what `POST /payment/x402` does (hour 1.5, 10 min)

**Files:** none

**Interfaces:**
- Consumes: a fresh, unpaid payment request.
- Produces: one paragraph in the spike record.

- [ ] **Step 1: Create a payment request that nobody buys, then call the x402 builder for an external buyer address**

```bash
ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP
cd /opt/hirakumi && set -a && . deploy/masumi.env && set +a; PS=http://127.0.0.1:3001/api/v1; H="token: $ADMIN_KEY"
PID=$(openssl rand -hex 10); IH=$(printf '%s;%s' "$PID" '{"symbol":"ADA"}' | sha256sum | cut -d' ' -f1)
BODY=$(jq -n --arg a "$SPIKE_AGENT_ID" --arg ih "$IH" --arg pid "$PID" --arg pb "$(date -u -d '+10 min' +%Y-%m-%dT%H:%M:%S.000Z)" \
  --arg sr "$(date -u -d '+20 min' +%Y-%m-%dT%H:%M:%S.000Z)" --arg ul "$(date -u -d '+36 min' +%Y-%m-%dT%H:%M:%S.000Z)" --arg ed "$(date -u -d '+52 min' +%Y-%m-%dT%H:%M:%S.000Z)" \
  '{network:"Preprod",agentIdentifier:$a,inputHash:$ih,identifierFromPurchaser:$pid,paymentSourceType:"Web3CardanoV2",supportedPaymentSourceIndex:0,payByTime:$pb,submitResultTime:$sr,unlockTime:$ul,externalDisputeUnlockTime:$ed}')
BC=$(curl -s -X POST $PS/payment -H "$H" -H 'content-type: application/json' -d "$BODY" | jq -r .data.blockchainIdentifier)
curl -s -X POST $PS/payment/x402 -H "$H" -H 'content-type: application/json' \
  -d "$(jq -n --arg bc "$BC" --arg a "<SELLER_DEMO_ADDRESS or any funded preprod address>" '{network:"Preprod",blockchainIdentifier:$bc,buyerAddress:$a}')" \
  | jq -c '{status, cborHexChars: (.data.unsignedTxCbor | length), collateralReturnLovelace: .data.collateralReturnLovelace, error: .error.message}'
```

Expected: `{"status":"success","cborHexChars":<thousands>,"collateralReturnLovelace":"<lovelace>","error":null}` if the address holds ≥1 Masumi tUSDM. Otherwise an error naming missing funds. Record: "`/payment/x402` returns an unsigned CIP-30-signable escrow **lock** tx for an external wallet against an existing Masumi payment request. It is not an x402 facilitator and does not settle pack payments. Decision: **ignore for packs**. Possible stretch: Eternl buyer for escrow jobs." The request expires unpaid at `payByTime`; no cleanup is needed.

---

### Task 8: Spike record and hour-2 post

**Files:**
- Create: `docs/spikes/p4-spike-results.md`

**Interfaces:**
- Produces: the hour-2 team-chat post and the contract deltas.

- [ ] **Step 1: Write `docs/spikes/p4-spike-results.md`** with the measured values:

```markdown
# P4 spike results (hour 0–2, 6 Oct 2026)

| Item | Value |
|---|---|
| EC2 | instance `<IID>`, t3.large ap-southeast-1, EIP `<EIP>`, `https://<PUBLIC_DOMAIN>` TLS ok at `<time>` |
| Payment service | image 0.29.0, seed ok, V2 escrow `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` |
| Selling wallet | `<addr>` (funded `<n>` tADA) |
| Purchasing wallet | `<addr>` (funded `<n>` tADA, `<n>` Masumi tUSDM) |
| REGISTRY_API_KEY | obtained yes/no, from whom |
| Registry mint | POST → RegistrationConfirmed in `<min>`; agentIdentifier `<id>` |
| First Online | `<min>` after confirm (passive) / `<s>` with refresh |
| Registry hit interval (stub log) | `<list of gaps, s>` |
| touch-down → Offline | passive `<min>` / refresh `<s>` |
| Escrow FundsLocked | `<min>` after payment request |
| Escrow pass | ResultSubmitted `<min>`, Withdrawn `<min>` after request |
| Collection to sellerReturnAddress | YES/NO; seller received `<x>` Masumi tUSDM |
| Escrow fail | RefundWithdrawn `<min>` after submitResultTime (`<min>` after request) |
| /payment/x402 | `<one-line finding>` |
| Field-name surprises vs plan | `<none / list>` |
```

Every `<…>` cell is filled with a measured value before committing. A cell that couldn't be measured says why ("no registry key").

- [ ] **Step 2: Post to team chat** the table plus "Contract deltas P4 proposes" items 1–8 from the top of this plan.

- [ ] **Step 3: Commit**

```bash
git add docs/spikes/p4-spike-results.md deploy/spike/escrow-spike.sh
git commit -m "docs(spike): P4 payment-service, registry and escrow measurements on preprod" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `packages/masumi` scaffold and HTTP client (TDD)

**Files:**
- Create: `packages/masumi/package.json`, `packages/masumi/tsconfig.json`, `packages/masumi/src/types.ts`, `packages/masumi/src/errors.ts`, `packages/masumi/src/constants.ts`, `packages/masumi/src/http.ts`, `packages/masumi/test/fakeFetch.ts`, `packages/masumi/test/http.test.ts`

**Interfaces:**
- Consumes: the root `pnpm-workspace.yaml` (`packages/*`) and `tsconfig.base.json` (P1).
- Produces:
  - `call<T>(baseUrl: string, token: string, method: "GET"|"POST", path: string, opts?: { query?: Record<string,string|number|undefined>; body?: unknown; timeoutMs?: number }): Promise<T>`
  - `class MasumiApiError extends Error { status: number; path: string }`
  - `class MasumiInputError extends Error`

- [ ] **Step 1: Write `packages/masumi/package.json` and `tsconfig.json`**

```json
{
  "name": "@hirakumi/masumi",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "smoke": "tsx scripts/smoke.ts",
    "register-e2e": "tsx scripts/register-e2e.ts",
    "measure-health": "tsx scripts/measure-health.ts",
    "escrow-e2e": "tsx scripts/escrow-e2e.ts"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "tsx": "4.23.15",
    "vite": "7.3.7",
    "vitest": "5.0.3"
  }
}
```

If P1 pinned different exact versions of these four packages at the workspace root, use P1's versions here (`pnpm -w list vitest vite tsx @types/node` shows them).

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src", "test", "scripts"]
}
```

Run: `pnpm install`
Expected: completes, and `packages/masumi/node_modules/.bin/vitest` exists.

- [ ] **Step 2: Write the fake server and the failing HTTP tests**

`packages/masumi/test/fakeFetch.ts`:

```ts
import { vi } from "vitest";

export type Recorded = { method: string; url: URL; headers: Record<string, string>; body: unknown };
type Reply = { status?: number; json: unknown };
type Handler = (req: Recorded) => Reply;

/** Replaces global fetch with a router keyed by "METHOD /pathname". Unknown routes answer 404. */
export function installFakeFetch(routes: Record<string, Handler>): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fake = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const req: Recorded = { method: init?.method ?? "GET", url, headers, body };
    calls.push(req);
    const handler = routes[`${req.method} ${url.pathname}`];
    const reply: Reply = handler
      ? handler(req)
      : { status: 404, json: { status: "error", error: { message: `no fake route for ${req.method} ${url.pathname}` } } };
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fake);
  return { calls };
}

export const ok = (data: unknown): Reply => ({ json: { status: "success", data } });
export const fail = (status: number, message: string): Reply => ({ status, json: { status: "error", error: { message } } });
```

`packages/masumi/test/http.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { call } from "../src/http.js";
import { MasumiApiError } from "../src/errors.js";
import { fail, installFakeFetch, ok } from "./fakeFetch.js";

const BASE = "http://ps.test/api/v1";
const TOKEN = "secret-admin-key-123";

afterEach(() => vi.unstubAllGlobals());

describe("call", () => {
  it("sends the token header and unwraps the success envelope", async () => {
    const { calls } = installFakeFetch({ "GET /api/v1/health": () => ok({ status: "ok" }) });
    await expect(call(BASE, TOKEN, "GET", "/health")).resolves.toEqual({ status: "ok" });
    expect(calls[0].headers.token).toBe(TOKEN);
  });

  it("adds only defined query params", async () => {
    const { calls } = installFakeFetch({ "GET /api/v1/registry": () => ok({ Assets: [] }) });
    await call(BASE, TOKEN, "GET", "/registry", { query: { network: "Preprod", cursorId: undefined, limit: 100 } });
    expect(calls[0].url.searchParams.get("network")).toBe("Preprod");
    expect(calls[0].url.searchParams.has("cursorId")).toBe(false);
    expect(calls[0].url.searchParams.get("limit")).toBe("100");
  });

  it("sends JSON bodies with a content-type", async () => {
    const { calls } = installFakeFetch({ "POST /api/v1/payment": () => ok({ id: "p1" }) });
    await call(BASE, TOKEN, "POST", "/payment", { body: { network: "Preprod" } });
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(calls[0].body).toEqual({ network: "Preprod" });
  });

  it("throws MasumiApiError with the node's message and never leaks the token", async () => {
    installFakeFetch({
      "POST /api/v1/payment": () =>
        fail(400, `key ${TOKEN}: Submit result time must be in the future (min. 15 minutes)`),
    });
    const error = await call(BASE, TOKEN, "POST", "/payment", { body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MasumiApiError);
    expect((error as MasumiApiError).status).toBe(400);
    expect((error as MasumiApiError).path).toBe("/payment");
    expect((error as Error).message).toContain("min. 15 minutes");
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("treats a 200 without the success envelope as an error", async () => {
    installFakeFetch({ "GET /api/v1/health": () => ({ json: { hello: "world" } }) });
    await expect(call(BASE, TOKEN, "GET", "/health")).rejects.toBeInstanceOf(MasumiApiError);
  });

  it("wraps network failures as status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const error = await call(BASE, TOKEN, "GET", "/health").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MasumiApiError);
    expect((error as MasumiApiError).status).toBe(0);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @hirakumi/masumi test`
Expected: FAIL. `Error: Cannot find module '../src/http.js'`.

- [ ] **Step 4: Implement types, errors, constants and http**

`packages/masumi/src/types.ts`:

```ts
export type MasumiConfig = {
  baseUrl: string;
  token: string;
  network: "Preprod";
  /** Masumi registry service (discovery). Needed only by getRegistryStatus / refreshRegistryStatus. */
  registryUrl?: string;
  registryToken?: string;
};

export type RegistryStatus = "Online" | "Offline" | "Deregistered" | "Invalid" | "Unknown";

export type PaymentState =
  | "WaitingForPayment"
  | "FundsLocked"
  | "ResultSubmitted"
  | "RefundRequested"
  | "Disputed"
  | "Withdrawn"
  | "RefundWithdrawn"
  | "Other";
```

`packages/masumi/src/errors.ts`:

```ts
/** The payment service or registry answered with an error (status 0 = no answer). */
export class MasumiApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, detail: string) {
    super(`Masumi ${path} returned ${status}: ${detail}`);
    this.name = "MasumiApiError";
    this.status = status;
    this.path = path;
  }
}

/** A value the Masumi node would reject; raised before any network call. */
export class MasumiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasumiInputError";
  }
}
```

`packages/masumi/src/constants.ts`:

```ts
/** Masumi preprod tUSDM (escrow token): policy 16a55b2a… + asset name 0014df10745553444d. Never the x402 e675b46e… token. */
export const MASUMI_ESCROW_UNIT =
  "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
export const PAYMENT_SOURCE_TYPE = "Web3CardanoV2";
/** Every Hirakumi agent advertises exactly one Cardano source, so the index is always 0. */
export const SUPPORTED_PAYMENT_SOURCE_INDEX = 0;
/** Node rule: submitResultTime ≥ now + 15 min (payments/index.ts, purchases/shared.ts). We keep 1 min of margin. */
export const MIN_SUBMIT_LEAD_MS = 16 * 60_000;
/** Node rule: payByTime ≤ submitResultTime − 5 min. */
export const MIN_PAYBY_GAP_MS = 5 * 60_000;
/** Node rule: unlockTime ≥ submitResultTime + 15 min (default would be +6 h). */
export const UNLOCK_AFTER_SUBMIT_MS = 16 * 60_000;
/** Node rule: externalDisputeUnlockTime ≥ unlockTime + 15 min. */
export const DISPUTE_AFTER_UNLOCK_MS = 16 * 60_000;
export const DEFAULT_REGISTRY_URL = "https://registry.masumi.network/api/v1";
```

`packages/masumi/src/http.ts`:

```ts
import { MasumiApiError } from "./errors.js";

export type Query = Record<string, string | number | undefined>;

type Envelope = { status?: string; data?: unknown; error?: { message?: string } };

/** One call to a Masumi service: `token` header, `{status:"success",data}` envelope, token-redacted errors. */
export async function call<T>(
  baseUrl: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  opts: { query?: Query; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { token, accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new MasumiApiError(0, path, `request failed: ${(error as Error).message}`);
  }

  const text = await response.text();
  let envelope: Envelope | undefined;
  try {
    envelope = text ? (JSON.parse(text) as Envelope) : undefined;
  } catch {
    envelope = undefined;
  }
  if (!response.ok || envelope?.status !== "success") {
    const raw = (envelope?.error?.message ?? text.slice(0, 300)) || response.statusText || "empty response";
    const detail = token ? raw.split(token).join("***") : raw;
    throw new MasumiApiError(response.status, path, detail);
  }
  return envelope.data as T;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @hirakumi/masumi test`
Expected: PASS, `test/http.test.ts (6 tests)`.

- [ ] **Step 6: Commit**

```bash
git add packages/masumi
git commit -m "feat(masumi): http client with token header, envelope unwrap and redacted errors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Registry functions (TDD)

**Files:**
- Create: `packages/masumi/src/registry.ts`, `packages/masumi/test/registry.test.ts`

**Interfaces:**
- Consumes: `call`, `MASUMI_ESCROW_UNIT`, `PAYMENT_SOURCE_TYPE`.
- Produces (contract and additions):
  - `registerAgent(c: MasumiConfig, a: { name: string; description: string; apiBaseUrl: string; priceMicros: bigint; unit: string; tags: string[]; exampleOutput?: string }): Promise<{ registrationId: string }>`
  - `getAgentIdentifier(c: MasumiConfig, registrationId: string): Promise<string | null>`
  - `getRegistryStatus(c: MasumiConfig, agentIdentifier: string): Promise<"Online"|"Offline"|"Deregistered"|"Invalid"|"Unknown">`
  - `refreshRegistryStatus(c: MasumiConfig, agentIdentifier: string): Promise<RegistryStatus>` (addition)

- [ ] **Step 1: Write the failing tests**

`packages/masumi/test/registry.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentIdentifier, getRegistryStatus, refreshRegistryStatus, registerAgent } from "../src/registry.js";
import { MASUMI_ESCROW_UNIT } from "../src/constants.js";
import { MasumiApiError, MasumiInputError } from "../src/errors.js";
import type { MasumiConfig } from "../src/types.js";
import { installFakeFetch, ok, type Recorded } from "./fakeFetch.js";

const C: MasumiConfig = {
  baseUrl: "http://ps.test/api/v1",
  token: "admin-key",
  network: "Preprod",
  registryUrl: "http://reg.test/api/v1",
  registryToken: "reg-key",
};
const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const VKEY = "a".repeat(56);
const AGENT_ID = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b" + "1".repeat(64);
const AGENT = {
  name: "Price API",
  description: "ADA price with a published promise",
  apiBaseUrl: "https://api.hirakumi.app/a/api_abc",
  priceMicros: 2_000_000n,
  unit: MASUMI_ESCROW_UNIT,
  tags: ["hirakumi", "prices"],
  exampleOutput: "https://api.hirakumi.app/r/sha256:abc",
};

const sourceRoutes = {
  "GET /api/v1/payment-source": () =>
    ok({
      PaymentSources: [
        { id: "ps_v1", network: "Preprod", paymentSourceType: "Web3CardanoV1", smartContractAddress: "addr_test1wv1" },
        { id: "ps_v2", network: "Preprod", paymentSourceType: "Web3CardanoV2", smartContractAddress: ESCROW },
      ],
    }),
  "GET /api/v1/wallet/list": (req: Recorded) => {
    expect(req.url.searchParams.get("walletType")).toBe("Selling");
    expect(req.url.searchParams.get("paymentSourceId")).toBe("ps_v2");
    return ok({ Wallets: [{ id: "w1", walletVkey: VKEY, walletAddress: "addr_test1qsell" }] });
  },
};

const entry = (over: Record<string, unknown> = {}) => ({
  id: "reg_1",
  state: "RegistrationRequested",
  agentIdentifier: null,
  error: null,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("registerAgent", () => {
  it("registers a V2 agent priced in Masumi tUSDM through the node's selling wallet", async () => {
    const { calls } = installFakeFetch({
      ...sourceRoutes,
      "POST /api/v1/registry": () => ok(entry()),
    });
    await expect(registerAgent(C, AGENT)).resolves.toEqual({ registrationId: "reg_1" });
    const body = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      network: "Preprod",
      sellingWalletVkey: VKEY,
      name: "Price API",
      description: AGENT.description,
      apiBaseUrl: AGENT.apiBaseUrl,
      Tags: ["hirakumi", "prices"],
      ExampleOutputs: [{ name: "example", url: AGENT.exampleOutput, mimeType: "application/json" }],
      Capability: { name: "hirakumi-openapi-wrapper", version: "1" },
      Author: { name: "Hirakumi" },
      supportedPaymentSources: [
        {
          chain: "Cardano",
          network: "Preprod",
          paymentSourceType: "Web3CardanoV2",
          address: ESCROW,
          pricing: { pricingType: "Fixed", fixed: [{ asset: MASUMI_ESCROW_UNIT, amount: "2000000" }] },
        },
      ],
    });
    expect(body).not.toHaveProperty("AgentPricing");
  });

  it("sends an empty ExampleOutputs list when there is no example", async () => {
    const { calls } = installFakeFetch({ ...sourceRoutes, "POST /api/v1/registry": () => ok(entry()) });
    await registerAgent(C, { ...AGENT, exampleOutput: undefined });
    expect((calls.find((c) => c.method === "POST")!.body as { ExampleOutputs: unknown[] }).ExampleOutputs).toEqual([]);
  });

  it("rejects bad listings before any network call", async () => {
    const { calls } = installFakeFetch({});
    const bad = [
      { ...AGENT, apiBaseUrl: "http://api.hirakumi.app/a/api_abc" },
      { ...AGENT, apiBaseUrl: "https://api.hirakumi.app/a/api_abc/" },
      { ...AGENT, tags: [] },
      { ...AGENT, tags: Array.from({ length: 16 }, (_, i) => `t${i}`) },
      { ...AGENT, tags: ["x".repeat(64)] },
      { ...AGENT, priceMicros: 0n },
      { ...AGENT, unit: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d" },
      { ...AGENT, name: "n".repeat(251) },
      { ...AGENT, exampleOutput: "ftp://example.test/x.json" },
    ];
    for (const listing of bad) {
      await expect(registerAgent(C, listing)).rejects.toBeInstanceOf(MasumiInputError);
    }
    expect(calls).toHaveLength(0);
  });

  it("fails clearly when the node has no Preprod V2 payment source", async () => {
    installFakeFetch({ "GET /api/v1/payment-source": () => ok({ PaymentSources: [] }) });
    await expect(registerAgent(C, AGENT)).rejects.toThrow(/no Preprod Web3CardanoV2 payment source/);
  });
});

describe("getAgentIdentifier", () => {
  it("returns null until the mint is confirmed", async () => {
    installFakeFetch({
      "GET /api/v1/registry": () => ok({ Assets: [entry({ state: "RegistrationInitiated", agentIdentifier: AGENT_ID })] }),
    });
    await expect(getAgentIdentifier(C, "reg_1")).resolves.toBeNull();
  });

  it("returns the agent identifier once RegistrationConfirmed", async () => {
    const { calls } = installFakeFetch({
      "GET /api/v1/registry": () => ok({ Assets: [entry({ state: "RegistrationConfirmed", agentIdentifier: AGENT_ID })] }),
    });
    await expect(getAgentIdentifier(C, "reg_1")).resolves.toBe(AGENT_ID);
    expect(calls[0].url.searchParams.get("network")).toBe("Preprod");
    expect(calls[0].url.searchParams.get("filterPaymentSourceType")).toBe("Web3CardanoV2");
    expect(calls[0].url.searchParams.get("limit")).toBe("100");
  });

  it("throws with the node's error when the registration failed", async () => {
    installFakeFetch({
      "GET /api/v1/registry": () => ok({ Assets: [entry({ state: "RegistrationFailed", error: "Not enough funds" })] }),
    });
    await expect(getAgentIdentifier(C, "reg_1")).rejects.toThrow(/Not enough funds/);
  });

  it("pages through the node's registry list with cursorId", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => entry({ id: `other_${i}` }));
    const { calls } = installFakeFetch({
      "GET /api/v1/registry": (req) =>
        req.url.searchParams.get("cursorId") === "other_99"
          ? ok({ Assets: [entry({ state: "RegistrationConfirmed", agentIdentifier: AGENT_ID })] })
          : ok({ Assets: page1 }),
    });
    await expect(getAgentIdentifier(C, "reg_1")).resolves.toBe(AGENT_ID);
    expect(calls).toHaveLength(2);
  });

  it("throws 404 when the registration does not exist on this node", async () => {
    installFakeFetch({ "GET /api/v1/registry": () => ok({ Assets: [] }) });
    const error = await getAgentIdentifier(C, "reg_missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MasumiApiError);
    expect((error as MasumiApiError).status).toBe(404);
  });
});

describe("registry status", () => {
  it("reads the entry by asset identifier from the registry service with the registry token", async () => {
    const { calls } = installFakeFetch({
      "POST /api/v1/registry-entry/": () => ok({ entries: [{ status: "Offline", lastUptimeCheck: "2026-10-07T03:00:00.000Z" }] }),
    });
    await expect(getRegistryStatus(C, AGENT_ID)).resolves.toBe("Offline");
    expect(calls[0].url.host).toBe("reg.test");
    expect(calls[0].headers.token).toBe("reg-key");
    expect(calls[0].body).toEqual({ network: "Preprod", filter: { assetIdentifier: AGENT_ID }, limit: 1 });
  });

  it("returns Unknown when the registry has not indexed the agent yet", async () => {
    installFakeFetch({ "POST /api/v1/registry-entry/": () => ok({ entries: [] }) });
    await expect(getRegistryStatus(C, AGENT_ID)).resolves.toBe("Unknown");
  });

  it("forces a fresh health check with refreshRegistryStatus", async () => {
    const { calls } = installFakeFetch({
      "POST /api/v1/registry-entry-refresh/": () => ok({ entry: { status: "Online" } }),
    });
    await expect(refreshRegistryStatus(C, AGENT_ID)).resolves.toBe("Online");
    expect(calls[0].body).toEqual({ network: "Preprod", agentIdentifier: AGENT_ID });
  });

  it("refuses to run without a registry token", async () => {
    const { calls } = installFakeFetch({});
    await expect(getRegistryStatus({ ...C, registryToken: undefined }, AGENT_ID)).rejects.toBeInstanceOf(MasumiInputError);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @hirakumi/masumi exec vitest run test/registry.test.ts`
Expected: FAIL. `Error: Cannot find module '../src/registry.js'`.

- [ ] **Step 3: Implement `packages/masumi/src/registry.ts`**

```ts
import { call } from "./http.js";
import { MasumiApiError, MasumiInputError } from "./errors.js";
import { DEFAULT_REGISTRY_URL, MASUMI_ESCROW_UNIT, PAYMENT_SOURCE_TYPE } from "./constants.js";
import type { MasumiConfig, RegistryStatus } from "./types.js";

export type AgentListing = {
  name: string;
  description: string;
  apiBaseUrl: string;
  priceMicros: bigint;
  unit: string;
  tags: string[];
  exampleOutput?: string;
};

type PaymentSourceDto = { id: string; network: string; paymentSourceType: string; smartContractAddress: string };
type WalletDto = { id: string; walletVkey: string; walletAddress: string };
type RegistrationDto = { id: string; state: string; agentIdentifier: string | null; error: string | null };

const PAGE = 100;
const MAX_PAGES = 50;
const MINTED = new Set(["RegistrationConfirmed", "UpdateRequested", "UpdateInitiated", "UpdateConfirmed", "UpdateFailed"]);
const STATUSES = new Set<RegistryStatus>(["Online", "Offline", "Deregistered", "Invalid"]);

function httpsUrl(field: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MasumiInputError(`${field} is not a URL: ${value}`);
  }
  if (url.protocol !== "https:") throw new MasumiInputError(`${field} must use https: ${value}`);
  if (value.length > 250) throw new MasumiInputError(`${field} must be at most 250 characters`);
  return url;
}

function validateListing(a: AgentListing): void {
  httpsUrl("apiBaseUrl", a.apiBaseUrl);
  if (a.apiBaseUrl.endsWith("/")) {
    throw new MasumiInputError(`apiBaseUrl must not end with "/": the registry appends "/availability" (${a.apiBaseUrl})`);
  }
  if (a.exampleOutput !== undefined) httpsUrl("exampleOutput", a.exampleOutput);
  if (a.name.length < 1 || a.name.length > 250) throw new MasumiInputError("name must be 1-250 characters");
  if (a.description.length < 1 || a.description.length > 250) throw new MasumiInputError("description must be 1-250 characters");
  if (a.tags.length < 1 || a.tags.length > 15) throw new MasumiInputError("tags must have 1-15 entries");
  for (const tag of a.tags) {
    if (tag.length < 1 || tag.length > 63) throw new MasumiInputError(`tag "${tag}" must be 1-63 characters`);
  }
  if (a.priceMicros <= 0n) throw new MasumiInputError("priceMicros must be positive");
  if (a.unit !== MASUMI_ESCROW_UNIT) {
    throw new MasumiInputError(`escrow must be priced in Masumi tUSDM (${MASUMI_ESCROW_UNIT}), not ${a.unit}`);
  }
}

async function v2Source(c: MasumiConfig): Promise<PaymentSourceDto> {
  const { PaymentSources } = await call<{ PaymentSources: PaymentSourceDto[] }>(c.baseUrl, c.token, "GET", "/payment-source", {
    query: { take: 100 },
  });
  const source = PaymentSources.find((s) => s.network === c.network && s.paymentSourceType === PAYMENT_SOURCE_TYPE);
  if (!source) {
    throw new MasumiApiError(404, "/payment-source", `no ${c.network} ${PAYMENT_SOURCE_TYPE} payment source is seeded on this node`);
  }
  return source;
}

async function sellingWallet(c: MasumiConfig, paymentSourceId: string): Promise<WalletDto> {
  const { Wallets } = await call<{ Wallets: WalletDto[] }>(c.baseUrl, c.token, "GET", "/wallet/list", {
    query: { walletType: "Selling", paymentSourceId, take: 1 },
  });
  if (!Wallets[0]) throw new MasumiApiError(404, "/wallet/list", "no selling wallet on the V2 payment source");
  return Wallets[0];
}

/** Mints the agent's registry NFT (V2 metadata) from the node's selling wallet, which pays the mint. */
export async function registerAgent(c: MasumiConfig, a: AgentListing): Promise<{ registrationId: string }> {
  validateListing(a);
  const source = await v2Source(c);
  const wallet = await sellingWallet(c, source.id);
  const registration = await call<RegistrationDto>(c.baseUrl, c.token, "POST", "/registry", {
    body: {
      network: c.network,
      sellingWalletVkey: wallet.walletVkey,
      name: a.name,
      description: a.description,
      apiBaseUrl: a.apiBaseUrl,
      Tags: a.tags,
      ExampleOutputs: a.exampleOutput ? [{ name: "example", url: a.exampleOutput, mimeType: "application/json" }] : [],
      Capability: { name: "hirakumi-openapi-wrapper", version: "1" },
      Author: { name: "Hirakumi" },
      supportedPaymentSources: [
        {
          chain: "Cardano",
          network: c.network,
          paymentSourceType: PAYMENT_SOURCE_TYPE,
          address: source.smartContractAddress,
          pricing: { pricingType: "Fixed", fixed: [{ asset: a.unit, amount: a.priceMicros.toString() }] },
        },
      ],
    },
  });
  return { registrationId: registration.id };
}

/** The 120-hex agent identifier once the mint is confirmed; null while it is pending. */
export async function getAgentIdentifier(c: MasumiConfig, registrationId: string): Promise<string | null> {
  let cursorId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { Assets } = await call<{ Assets: RegistrationDto[] }>(c.baseUrl, c.token, "GET", "/registry", {
      query: { network: c.network, filterPaymentSourceType: PAYMENT_SOURCE_TYPE, limit: PAGE, cursorId },
    });
    const hit = Assets.find((asset) => asset.id === registrationId);
    if (hit) {
      if (hit.state === "RegistrationFailed") {
        throw new MasumiApiError(409, "/registry", `registration ${registrationId} failed: ${hit.error ?? "no error message"}`);
      }
      return MINTED.has(hit.state) && hit.agentIdentifier ? hit.agentIdentifier : null;
    }
    if (Assets.length < PAGE) break;
    const next = Assets[Assets.length - 1].id;
    if (next === cursorId) break;
    cursorId = next;
  }
  throw new MasumiApiError(404, "/registry", `registration ${registrationId} not found on this node`);
}

function registry(c: MasumiConfig): { url: string; token: string } {
  if (!c.registryToken) {
    throw new MasumiInputError("Registry status needs a registry token: set REGISTRY_API_KEY (and REGISTRY_SERVICE_URL)");
  }
  return { url: c.registryUrl ?? DEFAULT_REGISTRY_URL, token: c.registryToken };
}

const toStatus = (status: unknown): RegistryStatus =>
  typeof status === "string" && STATUSES.has(status as RegistryStatus) ? (status as RegistryStatus) : "Unknown";

/** The registry service's last known status (refreshed by its own schedule). */
export async function getRegistryStatus(c: MasumiConfig, agentIdentifier: string): Promise<RegistryStatus> {
  const r = registry(c);
  const { entries } = await call<{ entries: Array<{ status?: string }> }>(r.url, r.token, "POST", "/registry-entry/", {
    body: { network: c.network, filter: { assetIdentifier: agentIdentifier }, limit: 1 },
  });
  return toStatus(entries[0]?.status);
}

/** Makes the registry re-index and health-check this one agent now, then returns the fresh status. */
export async function refreshRegistryStatus(c: MasumiConfig, agentIdentifier: string): Promise<RegistryStatus> {
  const r = registry(c);
  const { entry } = await call<{ entry: { status?: string } | null }>(r.url, r.token, "POST", "/registry-entry-refresh/", {
    body: { network: c.network, agentIdentifier },
  });
  return toStatus(entry?.status);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @hirakumi/masumi test`
Expected: PASS. `test/http.test.ts (6 tests)`, `test/registry.test.ts (13 tests)`.

- [ ] **Step 5: Commit**

```bash
git add packages/masumi/src/registry.ts packages/masumi/test/registry.test.ts
git commit -m "feat(masumi): V2 registry registration, mint polling and registry status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Payment functions, seller side (TDD)

**Files:**
- Create: `packages/masumi/src/payments.ts`, `packages/masumi/test/fixtures.ts`, `packages/masumi/test/payments.test.ts`

**Interfaces:**
- Consumes: `call`, the timing constants.
- Produces:
  - `createPaymentRequest(c: MasumiConfig, p: { agentIdentifier: string; inputHash: string; identifierFromPurchaser: string; submitResultTime: Date; payByTime: Date; sellerReturnAddress?: string }): Promise<{ blockchainIdentifier: string; payByTime: Date; submitResultTime: Date; unlockTime: Date; externalDisputeUnlockTime: Date; sellerVKey: string }>`
  - `getPaymentState(c: MasumiConfig, blockchainIdentifier: string): Promise<PaymentState>`
  - `submitResult(c: MasumiConfig, blockchainIdentifier: string, resultHash: string): Promise<void>`
  - internal exports for purchases and scripts: `resolvePayment(c, blockchainIdentifier): Promise<PaymentDto>`, `toPaymentState(onChainState: string | null): PaymentState`, `HEX64`, `PURCHASER_ID`, `AGENT_ID`, `type PaymentDto`

- [ ] **Step 1: Write the failing tests**

`packages/masumi/test/fixtures.ts` (shared payment-record fixture; a plain module so importing it never re-registers tests):

```ts
export const NOW = Date.parse("2026-10-07T03:00:00.000Z");
export const MIN = 60_000;
export const AGENT_ID = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b" + "1".repeat(64);
export const INPUT_HASH = "b".repeat(64);
export const PURCHASER = "0123456789abcdef0123";
export const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
export const payBy = new Date(NOW + 10 * MIN);
export const submit = new Date(NOW + 20 * MIN);
export const unlock = new Date(submit.getTime() + 16 * MIN);
export const dispute = new Date(unlock.getTime() + 16 * MIN);

/** A /payment or /payment/resolve-blockchain-identifier `data` object as the node returns it. */
export const paymentDto = (over: Record<string, unknown> = {}) => ({
  id: "pay_1",
  blockchainIdentifier: "bc_1",
  agentIdentifier: AGENT_ID,
  inputHash: INPUT_HASH,
  payByTime: String(payBy.getTime()),
  submitResultTime: String(submit.getTime()),
  unlockTime: String(unlock.getTime()),
  externalDisputeUnlockTime: String(dispute.getTime()),
  onChainState: null as string | null,
  sellerReturnAddress: null as string | null,
  RequestedFunds: [{ amount: "2000000", unit: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d" }],
  SmartContractWallet: { walletVkey: "c".repeat(56), walletAddress: "addr_test1qsell" },
  PaymentSource: { network: "Preprod", paymentSourceType: "Web3CardanoV2", smartContractAddress: ESCROW },
  NextAction: { requestedAction: "WaitingForExternalAction", errorType: null, errorNote: null },
  ...over,
});
```

`packages/masumi/test/payments.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentRequest, getPaymentState, submitResult } from "../src/payments.js";
import { MasumiInputError } from "../src/errors.js";
import type { MasumiConfig } from "../src/types.js";
import { installFakeFetch, ok } from "./fakeFetch.js";
import { AGENT_ID, INPUT_HASH, MIN, NOW, PURCHASER, dispute, payBy, paymentDto, submit, unlock } from "./fixtures.js";

const C: MasumiConfig = { baseUrl: "http://ps.test/api/v1", token: "admin-key", network: "Preprod" };
const request = { agentIdentifier: AGENT_ID, inputHash: INPUT_HASH, identifierFromPurchaser: PURCHASER, payByTime: payBy, submitResultTime: submit };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createPaymentRequest", () => {
  it("creates a V2 payment request with unlock and dispute times the node accepts", async () => {
    const { calls } = installFakeFetch({ "POST /api/v1/payment": () => ok(paymentDto()) });
    await expect(createPaymentRequest(C, request)).resolves.toEqual({
      blockchainIdentifier: "bc_1",
      payByTime: payBy,
      submitResultTime: submit,
      unlockTime: unlock,
      externalDisputeUnlockTime: dispute,
      sellerVKey: "c".repeat(56),
    });
    expect(calls[0].body).toEqual({
      network: "Preprod",
      agentIdentifier: AGENT_ID,
      inputHash: INPUT_HASH,
      identifierFromPurchaser: PURCHASER,
      paymentSourceType: "Web3CardanoV2",
      supportedPaymentSourceIndex: 0,
      payByTime: payBy.toISOString(),
      submitResultTime: submit.toISOString(),
      unlockTime: unlock.toISOString(),
      externalDisputeUnlockTime: dispute.toISOString(),
    });
  });

  it("forwards sellerReturnAddress so escrow earnings go to the seller", async () => {
    const seller = "addr_test1qseller000000000000000000000000000000000000000000";
    const { calls } = installFakeFetch({ "POST /api/v1/payment": () => ok(paymentDto({ sellerReturnAddress: seller })) });
    await createPaymentRequest(C, { ...request, sellerReturnAddress: seller });
    expect((calls[0].body as { sellerReturnAddress: string }).sellerReturnAddress).toBe(seller);
  });

  it("rejects deadlines the node would refuse, before calling it", async () => {
    const { calls } = installFakeFetch({});
    const cases = [
      { ...request, submitResultTime: new Date(NOW + 15 * MIN) },
      { ...request, payByTime: new Date(submit.getTime() - 4 * MIN) },
      { ...request, payByTime: new Date(NOW - MIN) },
    ];
    for (const c of cases) await expect(createPaymentRequest(C, c)).rejects.toBeInstanceOf(MasumiInputError);
    expect(calls).toHaveLength(0);
  });

  it("rejects identifiers and addresses the node would refuse", async () => {
    const { calls } = installFakeFetch({});
    const cases = [
      { ...request, identifierFromPurchaser: "not-hex-not-hex-not" },
      { ...request, identifierFromPurchaser: "0123456789abc" },
      { ...request, identifierFromPurchaser: "0".repeat(27) },
      { ...request, inputHash: "b".repeat(63) },
      { ...request, agentIdentifier: "abc" },
      { ...request, sellerReturnAddress: "addr1qmainnet" },
    ];
    for (const c of cases) await expect(createPaymentRequest(C, c)).rejects.toBeInstanceOf(MasumiInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("getPaymentState", () => {
  it.each([
    [null, "WaitingForPayment"],
    ["FundsLocked", "FundsLocked"],
    ["ResultSubmitted", "ResultSubmitted"],
    ["RefundRequested", "RefundRequested"],
    ["Disputed", "Disputed"],
    ["Withdrawn", "Withdrawn"],
    ["RefundWithdrawn", "RefundWithdrawn"],
    ["FundsOrDatumInvalid", "Other"],
    ["RefundAuthorized", "Other"],
    ["DisputedWithdrawn", "Other"],
  ])("maps onChainState %s to %s", async (onChainState, expected) => {
    const { calls } = installFakeFetch({
      "POST /api/v1/payment/resolve-blockchain-identifier": () => ok(paymentDto({ onChainState })),
    });
    await expect(getPaymentState(C, "bc_1")).resolves.toBe(expected);
    expect(calls[0].body).toEqual({ network: "Preprod", blockchainIdentifier: "bc_1" });
  });
});

describe("submitResult", () => {
  it("submits the 64-hex MIP-004 output hash", async () => {
    const hash = "d".repeat(64);
    const { calls } = installFakeFetch({ "POST /api/v1/payment/submit-result": () => ok(paymentDto()) });
    await submitResult(C, "bc_1", hash);
    expect(calls[0].body).toEqual({ network: "Preprod", blockchainIdentifier: "bc_1", submitResultHash: hash });
  });

  it("rejects a 128-hex input+output hash (the node only accepts 64 hex)", async () => {
    const { calls } = installFakeFetch({});
    await expect(submitResult(C, "bc_1", "a".repeat(64) + "b".repeat(64))).rejects.toThrow(/64-char hex/);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @hirakumi/masumi exec vitest run test/payments.test.ts`
Expected: FAIL. `Error: Cannot find module '../src/payments.js'`.

- [ ] **Step 3: Implement `packages/masumi/src/payments.ts`**

```ts
import { call } from "./http.js";
import { MasumiApiError, MasumiInputError } from "./errors.js";
import {
  DISPUTE_AFTER_UNLOCK_MS,
  MIN_PAYBY_GAP_MS,
  MIN_SUBMIT_LEAD_MS,
  PAYMENT_SOURCE_TYPE,
  SUPPORTED_PAYMENT_SOURCE_INDEX,
  UNLOCK_AFTER_SUBMIT_MS,
} from "./constants.js";
import type { MasumiConfig, PaymentState } from "./types.js";

export const HEX64 = /^[0-9a-f]{64}$/i;
/** Node rule (payments/schemas.ts): identifierFromPurchaser is 14–26 hex characters. */
export const PURCHASER_ID = /^[0-9a-f]{14,26}$/i;
export const AGENT_ID = /^[0-9a-f]{57,250}$/i;

export type PaymentDto = {
  id: string;
  blockchainIdentifier: string;
  agentIdentifier: string | null;
  inputHash: string | null;
  payByTime: string | null;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  onChainState: string | null;
  sellerReturnAddress: string | null;
  RequestedFunds: Array<{ amount: string; unit: string }>;
  SmartContractWallet: { walletVkey: string; walletAddress: string } | null;
  PaymentSource: { network: string; paymentSourceType: string; smartContractAddress: string };
  NextAction: { requestedAction: string; errorType: string | null; errorNote: string | null };
};

const DIRECT = new Set<PaymentState>(["FundsLocked", "ResultSubmitted", "RefundRequested", "Disputed", "Withdrawn", "RefundWithdrawn"]);

/** null = nothing locked on chain yet. States outside the contract's list collapse to "Other". */
export function toPaymentState(onChainState: string | null): PaymentState {
  if (onChainState === null) return "WaitingForPayment";
  return DIRECT.has(onChainState as PaymentState) ? (onChainState as PaymentState) : "Other";
}

function fromMs(field: string, value: string | null): Date {
  const ms = Number(value);
  if (value === null || !Number.isFinite(ms)) throw new MasumiApiError(502, "/payment", `${field} is not a unix-ms time: ${value}`);
  return new Date(ms);
}

export function assertPreprodAddress(field: string, address: string): void {
  if (!address.startsWith("addr_test1")) throw new MasumiInputError(`${field} must be a preprod address (addr_test1…)`);
}

export async function createPaymentRequest(
  c: MasumiConfig,
  p: {
    agentIdentifier: string;
    inputHash: string;
    identifierFromPurchaser: string;
    submitResultTime: Date;
    payByTime: Date;
    sellerReturnAddress?: string;
  },
): Promise<{
  blockchainIdentifier: string;
  payByTime: Date;
  submitResultTime: Date;
  unlockTime: Date;
  externalDisputeUnlockTime: Date;
  sellerVKey: string;
}> {
  if (!AGENT_ID.test(p.agentIdentifier)) throw new MasumiInputError("agentIdentifier must be the registry asset id (hex)");
  if (!HEX64.test(p.inputHash)) throw new MasumiInputError("inputHash must be a 64-char hex sha256 (MIP-004)");
  if (!PURCHASER_ID.test(p.identifierFromPurchaser)) {
    throw new MasumiInputError("identifierFromPurchaser must be 14-26 hex characters");
  }
  const now = Date.now();
  const submit = p.submitResultTime.getTime();
  const payBy = p.payByTime.getTime();
  if (submit < now + MIN_SUBMIT_LEAD_MS) {
    throw new MasumiInputError(`submitResultTime must be at least ${MIN_SUBMIT_LEAD_MS / 60_000} minutes from now (node minimum: 15)`);
  }
  if (payBy <= now) throw new MasumiInputError("payByTime must be in the future");
  if (payBy > submit - MIN_PAYBY_GAP_MS) throw new MasumiInputError("payByTime must be at least 5 minutes before submitResultTime");
  if (p.sellerReturnAddress !== undefined) assertPreprodAddress("sellerReturnAddress", p.sellerReturnAddress);

  const unlock = submit + UNLOCK_AFTER_SUBMIT_MS;
  const dispute = unlock + DISPUTE_AFTER_UNLOCK_MS;
  const payment = await call<PaymentDto>(c.baseUrl, c.token, "POST", "/payment", {
    body: {
      network: c.network,
      agentIdentifier: p.agentIdentifier,
      inputHash: p.inputHash,
      identifierFromPurchaser: p.identifierFromPurchaser,
      paymentSourceType: PAYMENT_SOURCE_TYPE,
      supportedPaymentSourceIndex: SUPPORTED_PAYMENT_SOURCE_INDEX,
      payByTime: new Date(payBy).toISOString(),
      submitResultTime: new Date(submit).toISOString(),
      unlockTime: new Date(unlock).toISOString(),
      externalDisputeUnlockTime: new Date(dispute).toISOString(),
      ...(p.sellerReturnAddress !== undefined ? { sellerReturnAddress: p.sellerReturnAddress } : {}),
    },
  });
  if (!payment.SmartContractWallet) {
    throw new MasumiApiError(502, "/payment", "response has no SmartContractWallet (seller vkey)");
  }
  return {
    blockchainIdentifier: payment.blockchainIdentifier,
    payByTime: payment.payByTime === null ? new Date(payBy) : fromMs("payByTime", payment.payByTime),
    submitResultTime: fromMs("submitResultTime", payment.submitResultTime),
    unlockTime: fromMs("unlockTime", payment.unlockTime),
    externalDisputeUnlockTime: fromMs("externalDisputeUnlockTime", payment.externalDisputeUnlockTime),
    sellerVKey: payment.SmartContractWallet.walletVkey,
  };
}

export async function resolvePayment(c: MasumiConfig, blockchainIdentifier: string): Promise<PaymentDto> {
  return call<PaymentDto>(c.baseUrl, c.token, "POST", "/payment/resolve-blockchain-identifier", {
    body: { network: c.network, blockchainIdentifier },
  });
}

export async function getPaymentState(c: MasumiConfig, blockchainIdentifier: string): Promise<PaymentState> {
  return toPaymentState((await resolvePayment(c, blockchainIdentifier)).onChainState);
}

/** resultHash = MIP-004 output hash sha256(identifier + ";" + output): 64 hex, NOT inputHash+outputHash. */
export async function submitResult(c: MasumiConfig, blockchainIdentifier: string, resultHash: string): Promise<void> {
  if (!HEX64.test(resultHash)) {
    throw new MasumiInputError("resultHash must be the 64-char hex MIP-004 output hash (not inputHash+outputHash)");
  }
  await call<unknown>(c.baseUrl, c.token, "POST", "/payment/submit-result", {
    body: { network: c.network, blockchainIdentifier, submitResultHash: resultHash },
  });
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @hirakumi/masumi test`
Expected: PASS. `test/payments.test.ts (16 tests)` plus the earlier files.

- [ ] **Step 5: Commit**

```bash
git add packages/masumi/src/payments.ts packages/masumi/test/payments.test.ts
git commit -m "feat(masumi): escrow payment requests with node timing rules, state mapping, result submission" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Purchase functions (demo buyer), env config, public index (TDD)

**Files:**
- Create: `packages/masumi/src/purchases.ts`, `packages/masumi/src/config.ts`, `packages/masumi/src/index.ts`, `packages/masumi/test/purchases.test.ts`, `packages/masumi/test/config.test.ts`

**Interfaces:**
- Consumes: `resolvePayment`, `toPaymentState`, the validators from `payments.ts`.
- Produces:
  - `createPurchase(c: MasumiConfig, p: { agentIdentifier: string; blockchainIdentifier: string; inputHash: string; identifierFromPurchaser: string; sellerVKey: string; payByTime: Date; submitResultTime: Date; unlockTime: Date; externalDisputeUnlockTime: Date; amountMicros: bigint }): Promise<{ purchaseId: string }>`. The demo buyer is on the same node as the seller and reads the signed `smartContractAddress` and `sellerReturnAddress` from the seller's own record.
  - `getPurchaseState(c, blockchainIdentifier): Promise<PaymentState>` (addition)
  - `masumiConfigFromEnv(env?: Record<string, string | undefined>): MasumiConfig` (addition)
  - `@hirakumi/masumi` index with the contract names

- [ ] **Step 1: Write the failing tests**

`packages/masumi/test/purchases.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPurchase, getPurchaseState } from "../src/purchases.js";
import { MASUMI_ESCROW_UNIT } from "../src/constants.js";
import { MasumiInputError } from "../src/errors.js";
import type { MasumiConfig } from "../src/types.js";
import { installFakeFetch, ok } from "./fakeFetch.js";
import { paymentDto } from "./fixtures.js";

const C: MasumiConfig = { baseUrl: "http://ps.test/api/v1", token: "admin-key", network: "Preprod" };
const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const seller = paymentDto();
const terms = {
  agentIdentifier: seller.agentIdentifier,
  blockchainIdentifier: "bc_1",
  inputHash: seller.inputHash,
  identifierFromPurchaser: "0123456789abcdef0123",
  sellerVKey: "c".repeat(56),
  payByTime: new Date(Number(seller.payByTime)),
  submitResultTime: new Date(Number(seller.submitResultTime)),
  unlockTime: new Date(Number(seller.unlockTime)),
  externalDisputeUnlockTime: new Date(Number(seller.externalDisputeUnlockTime)),
  amountMicros: 2_000_000n,
};

afterEach(() => vi.unstubAllGlobals());

describe("createPurchase", () => {
  it("locks funds from the purchasing wallet with the seller's signed terms", async () => {
    const returnAddr = "addr_test1qseller000000000000000000000000000000000000000000";
    const { calls } = installFakeFetch({
      "POST /api/v1/payment/resolve-blockchain-identifier": () => ok(paymentDto({ sellerReturnAddress: returnAddr })),
      "POST /api/v1/purchase": () => ok({ id: "pur_1" }),
    });
    await expect(createPurchase(C, terms)).resolves.toEqual({ purchaseId: "pur_1" });
    expect(calls.find((c) => c.url.pathname === "/api/v1/purchase")!.body).toEqual({
      network: "Preprod",
      blockchainIdentifier: "bc_1",
      paymentSourceType: "Web3CardanoV2",
      smartContractAddress: ESCROW,
      supportedPaymentSourceIndex: 0,
      inputHash: terms.inputHash,
      sellerVkey: "c".repeat(56),
      agentIdentifier: terms.agentIdentifier,
      Amounts: [{ amount: "2000000", unit: MASUMI_ESCROW_UNIT }],
      payByTime: seller.payByTime,
      submitResultTime: seller.submitResultTime,
      unlockTime: seller.unlockTime,
      externalDisputeUnlockTime: seller.externalDisputeUnlockTime,
      identifierFromPurchaser: "0123456789abcdef0123",
      sellerReturnAddress: returnAddr,
    });
  });

  it("omits sellerReturnAddress when the seller did not sign one", async () => {
    const { calls } = installFakeFetch({
      "POST /api/v1/payment/resolve-blockchain-identifier": () => ok(paymentDto()),
      "POST /api/v1/purchase": () => ok({ id: "pur_2" }),
    });
    await createPurchase(C, terms);
    expect(calls.find((c) => c.url.pathname === "/api/v1/purchase")!.body).not.toHaveProperty("sellerReturnAddress");
  });

  it("refuses terms that differ from the seller's payment request", async () => {
    const { calls } = installFakeFetch({
      "POST /api/v1/payment/resolve-blockchain-identifier": () => ok(paymentDto()),
    });
    const stale = { ...terms, submitResultTime: new Date(terms.submitResultTime.getTime() + 60_000) };
    await expect(createPurchase(C, stale)).rejects.toThrow(/submitResultTime/);
    expect(calls.some((c) => c.url.pathname === "/api/v1/purchase")).toBe(false);
  });

  it("rejects malformed inputs before any call", async () => {
    const { calls } = installFakeFetch({});
    for (const bad of [{ ...terms, amountMicros: 0n }, { ...terms, sellerVKey: "xyz" }, { ...terms, identifierFromPurchaser: "zz" }]) {
      await expect(createPurchase(C, bad)).rejects.toBeInstanceOf(MasumiInputError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("getPurchaseState", () => {
  it("reads the buyer-side record", async () => {
    const { calls } = installFakeFetch({
      "POST /api/v1/purchase/resolve-blockchain-identifier": () => ok({ onChainState: "RefundWithdrawn" }),
    });
    await expect(getPurchaseState(C, "bc_1")).resolves.toBe("RefundWithdrawn");
    expect(calls[0].body).toEqual({ network: "Preprod", blockchainIdentifier: "bc_1" });
  });
});
```

`packages/masumi/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { masumiConfigFromEnv } from "../src/config.js";
import * as api from "../src/index.js";

describe("masumiConfigFromEnv", () => {
  it("reads the contract env names and defaults the registry URL", () => {
    expect(
      masumiConfigFromEnv({
        PAYMENT_SERVICE_URL: "http://payment-service:3001/api/v1",
        PAYMENT_SERVICE_TOKEN: "t",
        REGISTRY_API_KEY: "r",
      }),
    ).toEqual({
      baseUrl: "http://payment-service:3001/api/v1",
      token: "t",
      network: "Preprod",
      registryUrl: "https://registry.masumi.network/api/v1",
      registryToken: "r",
    });
  });

  it("names the missing variable", () => {
    expect(() => masumiConfigFromEnv({ PAYMENT_SERVICE_URL: "http://x/api/v1" })).toThrow(/PAYMENT_SERVICE_TOKEN/);
  });
});

describe("public API", () => {
  it("exports every contract function", () => {
    for (const name of [
      "registerAgent",
      "getAgentIdentifier",
      "getRegistryStatus",
      "createPaymentRequest",
      "getPaymentState",
      "submitResult",
      "createPurchase",
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @hirakumi/masumi exec vitest run test/purchases.test.ts test/config.test.ts`
Expected: FAIL. `Error: Cannot find module '../src/purchases.js'` and `../src/config.js`.

- [ ] **Step 3: Implement `purchases.ts`, `config.ts`, `index.ts`**

`packages/masumi/src/purchases.ts`:

```ts
import { call } from "./http.js";
import { MasumiInputError } from "./errors.js";
import { MASUMI_ESCROW_UNIT, PAYMENT_SOURCE_TYPE, SUPPORTED_PAYMENT_SOURCE_INDEX } from "./constants.js";
import { AGENT_ID, HEX64, PURCHASER_ID, resolvePayment, toPaymentState } from "./payments.js";
import type { MasumiConfig, PaymentState } from "./types.js";

const VKEY = /^[0-9a-f]{56}$/i;

/**
 * Demo escrow buyer: locks Masumi tUSDM from this node's purchasing wallet.
 * The seller is this same node, so the signed smartContractAddress and sellerReturnAddress
 * come from the seller's own payment record. The node verifies the seller signature over them.
 */
export async function createPurchase(
  c: MasumiConfig,
  p: {
    agentIdentifier: string;
    blockchainIdentifier: string;
    inputHash: string;
    identifierFromPurchaser: string;
    sellerVKey: string;
    payByTime: Date;
    submitResultTime: Date;
    unlockTime: Date;
    externalDisputeUnlockTime: Date;
    amountMicros: bigint;
  },
): Promise<{ purchaseId: string }> {
  if (!AGENT_ID.test(p.agentIdentifier)) throw new MasumiInputError("agentIdentifier must be the registry asset id (hex)");
  if (!HEX64.test(p.inputHash)) throw new MasumiInputError("inputHash must be a 64-char hex sha256 (MIP-004)");
  if (!PURCHASER_ID.test(p.identifierFromPurchaser)) throw new MasumiInputError("identifierFromPurchaser must be 14-26 hex characters");
  if (!VKEY.test(p.sellerVKey)) throw new MasumiInputError("sellerVKey must be a 56-char hex payment key hash");
  if (p.amountMicros <= 0n) throw new MasumiInputError("amountMicros must be positive");

  const payment = await resolvePayment(c, p.blockchainIdentifier);
  const expected: Array<[string, string | null | undefined, string]> = [
    ["agentIdentifier", payment.agentIdentifier, p.agentIdentifier],
    ["inputHash", payment.inputHash, p.inputHash],
    ["sellerVKey", payment.SmartContractWallet?.walletVkey, p.sellerVKey],
    ["payByTime", payment.payByTime, String(p.payByTime.getTime())],
    ["submitResultTime", payment.submitResultTime, String(p.submitResultTime.getTime())],
    ["unlockTime", payment.unlockTime, String(p.unlockTime.getTime())],
    ["externalDisputeUnlockTime", payment.externalDisputeUnlockTime, String(p.externalDisputeUnlockTime.getTime())],
  ];
  const differing = expected.filter(([, seller, buyer]) => seller !== buyer).map(([name]) => name);
  if (differing.length > 0) {
    throw new MasumiInputError(`purchase terms differ from the seller's payment request: ${differing.join(", ")}`);
  }

  const purchase = await call<{ id: string }>(c.baseUrl, c.token, "POST", "/purchase", {
    body: {
      network: c.network,
      blockchainIdentifier: p.blockchainIdentifier,
      paymentSourceType: PAYMENT_SOURCE_TYPE,
      smartContractAddress: payment.PaymentSource.smartContractAddress,
      supportedPaymentSourceIndex: SUPPORTED_PAYMENT_SOURCE_INDEX,
      inputHash: p.inputHash,
      sellerVkey: p.sellerVKey,
      agentIdentifier: p.agentIdentifier,
      Amounts: [{ amount: p.amountMicros.toString(), unit: MASUMI_ESCROW_UNIT }],
      payByTime: String(p.payByTime.getTime()),
      submitResultTime: String(p.submitResultTime.getTime()),
      unlockTime: String(p.unlockTime.getTime()),
      externalDisputeUnlockTime: String(p.externalDisputeUnlockTime.getTime()),
      identifierFromPurchaser: p.identifierFromPurchaser,
      ...(payment.sellerReturnAddress ? { sellerReturnAddress: payment.sellerReturnAddress } : {}),
    },
  });
  return { purchaseId: purchase.id };
}

export async function getPurchaseState(c: MasumiConfig, blockchainIdentifier: string): Promise<PaymentState> {
  const purchase = await call<{ onChainState: string | null }>(c.baseUrl, c.token, "POST", "/purchase/resolve-blockchain-identifier", {
    body: { network: c.network, blockchainIdentifier },
  });
  return toPaymentState(purchase.onChainState);
}
```

`packages/masumi/src/config.ts`:

```ts
import { DEFAULT_REGISTRY_URL } from "./constants.js";
import { MasumiInputError } from "./errors.js";
import type { MasumiConfig } from "./types.js";

/** Builds the config from the contract's env names (PAYMENT_SERVICE_URL, PAYMENT_SERVICE_TOKEN, REGISTRY_*). */
export function masumiConfigFromEnv(env: Record<string, string | undefined> = process.env): MasumiConfig {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new MasumiInputError(`Set ${name} (see .env.example)`);
    return value;
  };
  return {
    baseUrl: need("PAYMENT_SERVICE_URL"),
    token: need("PAYMENT_SERVICE_TOKEN"),
    network: "Preprod",
    registryUrl: env.REGISTRY_SERVICE_URL?.trim() || DEFAULT_REGISTRY_URL,
    registryToken: env.REGISTRY_API_KEY?.trim() || undefined,
  };
}
```

`packages/masumi/src/index.ts`:

```ts
export type { MasumiConfig, PaymentState, RegistryStatus } from "./types.js";
export { MasumiApiError, MasumiInputError } from "./errors.js";
export { DEFAULT_REGISTRY_URL, MASUMI_ESCROW_UNIT } from "./constants.js";
export { masumiConfigFromEnv } from "./config.js";
export { getAgentIdentifier, getRegistryStatus, refreshRegistryStatus, registerAgent } from "./registry.js";
export { createPaymentRequest, getPaymentState, submitResult } from "./payments.js";
export { createPurchase, getPurchaseState } from "./purchases.js";
```

- [ ] **Step 4: Run all tests and the typecheck**

Run: `pnpm --filter @hirakumi/masumi test && pnpm --filter @hirakumi/masumi typecheck`
Expected: PASS for `http (6)`, `registry (13)`, `payments (16)`, `purchases (5)`, `config (3)`. `tsc` exits 0 with no output.

- [ ] **Step 5: Commit**

```bash
git add packages/masumi/src packages/masumi/test
git commit -m "feat(masumi): demo-buyer purchases, env config and public API index" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Script helpers (TDD) and the live preprod smoke script

**Files:**
- Create: `packages/masumi/scripts/env.ts`, `packages/masumi/scripts/lib.ts`, `packages/masumi/test/lib.test.ts`, `packages/masumi/scripts/smoke.ts`

**Interfaces:**
- Produces:
  - `mip004(identifier: string, payload: string): string`
  - `jcsFlat(obj: Record<string,string>): string`
  - `intervalSeconds(isoTimes: string[]): { count: number; min: number; median: number; max: number } | null`
  - `parseStartJob(body: Record<string, unknown>): StartJobTerms`
  - `loadRootEnv(): void`
  - CLI `pnpm --filter @hirakumi/masumi smoke` (exit 0 = everything P4 depends on is live)

- [ ] **Step 1: Write the failing helper tests**

`packages/masumi/test/lib.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { intervalSeconds, jcsFlat, mip004, parseStartJob } from "../scripts/lib.js";

describe("script helpers", () => {
  it("mip004 hashes identifier;payload (known vector)", () => {
    expect(mip004("0123456789abcdef0123", jcsFlat({ symbol: "ADA", nonce: "n1" }))).toBe(
      "ffaf6b90e93a6b18b4fda9e58780d78e1fbd1194a0d5397fef24eccc155c56f1",
    );
  });

  it("jcsFlat sorts keys", () => {
    expect(jcsFlat({ symbol: "ADA", nonce: "n1" })).toBe('{"nonce":"n1","symbol":"ADA"}');
  });

  it("intervalSeconds summarises gaps between distinct check times", () => {
    expect(intervalSeconds(["2026-10-07T03:00:00Z", "2026-10-07T03:01:40Z", "2026-10-07T03:01:40Z", "2026-10-07T03:05:00Z"])).toEqual({
      count: 2,
      min: 100,
      median: 200,
      max: 200,
    });
    expect(intervalSeconds(["2026-10-07T03:00:00Z"])).toBeNull();
  });

  it("parseStartJob reads MIP-003 terms and unix-ms times", () => {
    const t = parseStartJob({
      job_id: "job_1",
      blockchainIdentifier: "bc_1",
      agentIdentifier: "a".repeat(120),
      sellerVKey: "c".repeat(56),
      input_hash: "b".repeat(64),
      identifierFromPurchaser: "0123456789abcdef0123",
      payByTime: 1_791_000_000_000,
      submitResultTime: "1791000600000",
      unlockTime: 1_791_001_560_000,
      externalDisputeUnlockTime: 1_791_002_520_000,
    });
    expect(t.jobId).toBe("job_1");
    expect(t.submitResultTime.getTime()).toBe(1_791_000_600_000);
    expect(() => parseStartJob({ job_id: "x" })).toThrow(/missing blockchainIdentifier/);
  });
});
```

Run: `pnpm --filter @hirakumi/masumi exec vitest run test/lib.test.ts`
Expected: FAIL. `Error: Cannot find module '../scripts/lib.js'`.

- [ ] **Step 2: Implement `scripts/lib.ts` and `scripts/env.ts`**

`packages/masumi/scripts/lib.ts`:

```ts
import { createHash } from "node:crypto";

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** MIP-004: sha256(identifier_from_purchaser + ";" + payload). payload = JCS(input) for input hashes, raw output for results. */
export const mip004 = (identifier: string, payload: string): string => sha256Hex(`${identifier};${payload}`);

/** RFC 8785 for a flat object of strings: sorted keys, JSON string escaping (sufficient for the E2E inputs). */
export function jcsFlat(obj: Record<string, string>): string {
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(obj[key])}`)
    .join(",")}}`;
}

export function intervalSeconds(isoTimes: string[]): { count: number; min: number; median: number; max: number } | null {
  const times = [...new Set(isoTimes)].map((t) => Date.parse(t)).sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 1000).sort((a, b) => a - b);
  return { count: gaps.length, min: gaps[0], median: gaps[Math.floor(gaps.length / 2)], max: gaps[gaps.length - 1] };
}

export type StartJobTerms = {
  jobId: string;
  blockchainIdentifier: string;
  agentIdentifier: string;
  sellerVKey: string;
  inputHash: string;
  identifierFromPurchaser: string;
  payByTime: Date;
  submitResultTime: Date;
  unlockTime: Date;
  externalDisputeUnlockTime: Date;
};

/** Reads a MIP-003 start_job response (field names per contract delta 6). */
export function parseStartJob(body: Record<string, unknown>): StartJobTerms {
  const need = (key: string): unknown => {
    const value = body[key];
    if (value === undefined || value === null || value === "") throw new Error(`start_job response is missing ${key}`);
    return value;
  };
  const ms = (key: string): Date => {
    const n = Number(need(key));
    if (!Number.isFinite(n)) throw new Error(`start_job ${key} is not a unix-ms time`);
    return new Date(n);
  };
  return {
    jobId: String(need("job_id")),
    blockchainIdentifier: String(need("blockchainIdentifier")),
    agentIdentifier: String(need("agentIdentifier")),
    sellerVKey: String(need("sellerVKey")),
    inputHash: String(need("input_hash")),
    identifierFromPurchaser: String(need("identifierFromPurchaser")),
    payByTime: ms("payByTime"),
    submitResultTime: ms("submitResultTime"),
    unlockTime: ms("unlockTime"),
    externalDisputeUnlockTime: ms("externalDisputeUnlockTime"),
  };
}
```

`packages/masumi/scripts/env.ts`:

```ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Loads the repo-root .env without overriding variables already set in the shell (e.g. an SSH-tunnel PAYMENT_SERVICE_URL). */
export function loadRootEnv(): void {
  const path = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (!existsSync(path)) return;
  const before = { ...process.env };
  process.loadEnvFile(path);
  Object.assign(process.env, before);
}
```

Run: `pnpm --filter @hirakumi/masumi exec vitest run test/lib.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Write `scripts/smoke.ts`**

```ts
import { masumiConfigFromEnv } from "../src/config.js";
import { call } from "../src/http.js";
import { MASUMI_ESCROW_UNIT, PAYMENT_SOURCE_TYPE } from "../src/constants.js";
import { getRegistryStatus } from "../src/registry.js";
import { loadRootEnv } from "./env.js";

loadRootEnv();
const c = masumiConfigFromEnv();
const V2_PREPROD_ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const BLOCKFROST = "https://cardano-preprod.blockfrost.io/api/v0";
const rows: Array<{ check: string; ok: boolean; detail: string }> = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    rows.push({ check: name, ok: true, detail: await fn() });
  } catch (error) {
    rows.push({ check: name, ok: false, detail: (error as Error).message });
  }
}

async function balance(address: string): Promise<{ lovelace: bigint; escrowUnit: bigint }> {
  const key = process.env.BLOCKFROST_PROJECT_ID;
  if (!key) throw new Error("BLOCKFROST_PROJECT_ID not set");
  const response = await fetch(`${BLOCKFROST}/addresses/${address}`, { headers: { project_id: key } });
  if (response.status === 404) return { lovelace: 0n, escrowUnit: 0n };
  if (!response.ok) throw new Error(`Blockfrost ${response.status}`);
  const { amount } = (await response.json()) as { amount: Array<{ unit: string; quantity: string }> };
  const quantity = (unit: string) => BigInt(amount.find((a) => a.unit === unit)?.quantity ?? "0");
  return { lovelace: quantity("lovelace"), escrowUnit: quantity(MASUMI_ESCROW_UNIT) };
}

await check("health", async () => {
  const health = await call<{ status: string }>(c.baseUrl, c.token, "GET", "/health");
  if (health.status !== "ok") throw new Error(`status=${health.status}`);
  return "ok";
});

await check("api key accepted", async () => {
  await call<unknown>(c.baseUrl, c.token, "GET", "/api-key-status");
  return "token valid";
});

let sourceId = "";
await check("V2 preprod payment source", async () => {
  const { PaymentSources } = await call<{
    PaymentSources: Array<{ id: string; network: string; paymentSourceType: string; smartContractAddress: string }>;
  }>(c.baseUrl, c.token, "GET", "/payment-source", { query: { take: 100 } });
  const source = PaymentSources.find((s) => s.network === c.network && s.paymentSourceType === PAYMENT_SOURCE_TYPE);
  if (!source) throw new Error("not seeded");
  if (source.smartContractAddress !== V2_PREPROD_ESCROW) throw new Error(`unexpected escrow ${source.smartContractAddress}`);
  sourceId = source.id;
  return source.smartContractAddress;
});

const minimums: Array<[string, bigint, bigint]> = [
  ["Selling", 30_000_000n, 0n],
  ["Purchasing", 30_000_000n, 3_000_000n],
];
for (const [walletType, minLovelace, minEscrowUnit] of minimums) {
  await check(`${walletType} wallet funded`, async () => {
    const { Wallets } = await call<{ Wallets: Array<{ walletAddress: string }> }>(c.baseUrl, c.token, "GET", "/wallet/list", {
      query: { walletType, paymentSourceId: sourceId, take: 10 },
    });
    if (!Wallets[0]) throw new Error("no wallet");
    const b = await balance(Wallets[0].walletAddress);
    const detail = `${Wallets[0].walletAddress} ${Number(b.lovelace) / 1e6} tADA, ${Number(b.escrowUnit) / 1e6} Masumi tUSDM`;
    if (b.lovelace < minLovelace || b.escrowUnit < minEscrowUnit) throw new Error(`underfunded: ${detail}`);
    return detail;
  });
}

await check("live OpenAPI has every field packages/masumi sends", async () => {
  const response = await fetch(`${new URL(c.baseUrl).origin}/api-docs`);
  if (!response.ok) throw new Error(`/api-docs returned ${response.status}`);
  const spec = await response.text();
  const required = [
    "/payment/submit-result", "/payment/resolve-blockchain-identifier", "/purchase/resolve-blockchain-identifier",
    "/wallet/list", "/registry", "/payment-source", "supportedPaymentSourceIndex", "supportedPaymentSources",
    "sellerReturnAddress", "submitResultHash", "sellerVkey", "sellingWalletVkey", "identifierFromPurchaser",
    "externalDisputeUnlockTime", "smartContractAddress", "filterPaymentSourceType",
  ];
  const missing = required.filter((name) => !spec.includes(name));
  if (missing.length > 0) throw new Error(`missing in live spec: ${missing.join(", ")}`);
  return `${required.length} names present`;
});

if (c.registryToken) {
  await check("registry service reachable", async () => `unknown id → ${await getRegistryStatus(c, "0".repeat(120))}`);
} else {
  rows.push({ check: "registry service reachable", ok: false, detail: "REGISTRY_API_KEY not set" });
}

console.table(rows);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
```

- [ ] **Step 4: Run it live against preprod (laptop, SSH tunnel)**

```bash
ssh -i ~/.ssh/hirakumi.pem -f -N -L 3001:127.0.0.1:3001 ubuntu@$EIP
PAYMENT_SERVICE_URL=http://localhost:3001/api/v1 pnpm --filter @hirakumi/masumi smoke
```

Expected: a table of 7 rows, all `ok: true`, and exit code 0. Specifically:
- `V2 preprod payment source` shows `addr_test1wzs4e6…37w4g`;
- `Purchasing wallet funded` shows ≥3 Masumi tUSDM;
- the OpenAPI row shows `16 names present`.

If the OpenAPI row lists a missing name, open `http://localhost:3001/docs`, find the real name, and fix it in `src/` **and** its test. Then rerun Task 12 step 4 and this step.

- [ ] **Step 5: Commit**

```bash
git add packages/masumi/scripts/env.ts packages/masumi/scripts/lib.ts packages/masumi/scripts/smoke.ts packages/masumi/test/lib.test.ts
git commit -m "feat(masumi): MIP-004/JCS script helpers and live preprod smoke check" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Registry E2E and health-interval scripts

**Files:**
- Create: `packages/masumi/scripts/register-e2e.ts`, `packages/masumi/scripts/measure-health.ts`

**Interfaces:**
- Consumes: `registerAgent`, `getAgentIdentifier`, `refreshRegistryStatus`, `call`, `intervalSeconds`.
- Produces: CLI output `AGENT_IDENTIFIER=<120 hex>`, a Cardanoscan link, `registry=Online`, and the JSON line `{"healthCheckIntervalSeconds":{…}}`.

- [ ] **Step 1: Write `scripts/register-e2e.ts`**

```ts
import { parseArgs } from "node:util";
import { masumiConfigFromEnv } from "../src/config.js";
import { MASUMI_ESCROW_UNIT } from "../src/constants.js";
import { getAgentIdentifier, refreshRegistryStatus, registerAgent } from "../src/registry.js";
import { loadRootEnv } from "./env.js";

loadRootEnv();
const { values } = parseArgs({
  options: {
    name: { type: "string" },
    description: { type: "string" },
    url: { type: "string" },
    price: { type: "string", default: "1000000" },
    tag: { type: "string", multiple: true, default: ["hirakumi"] },
    example: { type: "string" },
    registration: { type: "string" },
  },
});
const c = masumiConfigFromEnv();
const start = Date.now();
const elapsed = () => `+${Math.round((Date.now() - start) / 1000)}s`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let registrationId = values.registration;
if (!registrationId) {
  if (!values.name || !values.description || !values.url) {
    throw new Error("--name, --description and --url are required (or --registration <id> to resume)");
  }
  ({ registrationId } = await registerAgent(c, {
    name: values.name,
    description: values.description,
    apiBaseUrl: values.url,
    priceMicros: BigInt(values.price),
    unit: MASUMI_ESCROW_UNIT,
    tags: values.tag,
    exampleOutput: values.example,
  }));
  console.log(`${elapsed()} registrationId=${registrationId}`);
}

let agentIdentifier: string | null = null;
while (agentIdentifier === null) {
  if (Date.now() - start > 30 * 60_000) throw new Error("not minted after 30 min: check selling-wallet tADA and `docker compose logs payment-service`");
  agentIdentifier = await getAgentIdentifier(c, registrationId);
  console.log(`${elapsed()} minted=${agentIdentifier ?? "not yet"}`);
  if (agentIdentifier === null) await sleep(15_000);
}
console.log(`AGENT_IDENTIFIER=${agentIdentifier}`);
console.log(`https://preprod.cardanoscan.io/token/${agentIdentifier}`);

if (!c.registryToken) {
  console.log("REGISTRY_API_KEY not set: skipping the Online check");
  process.exit(0);
}
for (;;) {
  const status = await refreshRegistryStatus(c, agentIdentifier);
  console.log(`${elapsed()} registry=${status}`);
  if (status === "Online") break;
  if (status === "Invalid") {
    throw new Error("registry says Invalid: /availability returned another agentIdentifier, redirected, or the URL is not public");
  }
  if (Date.now() - start > 45 * 60_000) throw new Error("not Online after 45 min");
  await sleep(30_000);
}
```

- [ ] **Step 2: Write `scripts/measure-health.ts`**

```ts
import { parseArgs } from "node:util";
import { masumiConfigFromEnv } from "../src/config.js";
import { DEFAULT_REGISTRY_URL } from "../src/constants.js";
import { call } from "../src/http.js";
import { refreshRegistryStatus } from "../src/registry.js";
import { loadRootEnv } from "./env.js";
import { intervalSeconds } from "./lib.js";

loadRootEnv();
const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    minutes: { type: "string", default: "30" },
    refresh: { type: "boolean", default: false },
  },
});
if (!values.agent) throw new Error("--agent <agentIdentifier> is required");
const agent = values.agent;
const c = masumiConfigFromEnv();
if (!c.registryToken) throw new Error("Set REGISTRY_API_KEY: this script reads the Masumi registry service");
const registryToken: string = c.registryToken;
const registryUrl = c.registryUrl ?? DEFAULT_REGISTRY_URL;

if (values.refresh) {
  const t0 = Date.now();
  const status = await refreshRegistryStatus(c, agent);
  console.log(`${new Date().toISOString()} refresh → ${status} in ${Date.now() - t0} ms`);
  process.exit(0);
}

const until = Date.now() + Number(values.minutes) * 60_000;
const checks: string[] = [];
let last = "";
while (Date.now() < until) {
  const { entries } = await call<{ entries: Array<{ status: string; lastUptimeCheck: string }> }>(
    registryUrl, registryToken, "POST", "/registry-entry/",
    { body: { network: c.network, filter: { assetIdentifier: agent }, limit: 1 } },
  );
  const entry = entries[0];
  const line = entry ? `${entry.status} lastUptimeCheck=${entry.lastUptimeCheck}` : "not indexed";
  if (line !== last) {
    console.log(`${new Date().toISOString()} ${line}`);
    last = line;
  }
  if (entry && !checks.includes(entry.lastUptimeCheck)) checks.push(entry.lastUptimeCheck);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
console.log(JSON.stringify({ agent, healthCheckIntervalSeconds: intervalSeconds(checks) }));
```

- [ ] **Step 3: Typecheck and do a live dry run**

Run: `pnpm --filter @hirakumi/masumi typecheck`
Expected: exit 0.

Run (re-uses the spike agent, no new mint): `PAYMENT_SERVICE_URL=http://localhost:3001/api/v1 pnpm --filter @hirakumi/masumi register-e2e --registration <spike registrationId from Task 5>`
Expected: `minted=<SPIKE_AGENT_ID>`, `AGENT_IDENTIFIER=…`, and `registry=Online` (or `REGISTRY_API_KEY not set…`).

Run: `pnpm --filter @hirakumi/masumi measure-health --agent $SPIKE_AGENT_ID --minutes 20`
Expected: one line per `lastUptimeCheck` change, then `{"agent":…,"healthCheckIntervalSeconds":{"count":…,"min":…,"median":…,"max":…}}`. Copy it into `docs/spikes/p4-spike-results.md` ("Registry hit interval") and commit that file with this task.

- [ ] **Step 4: Commit**

```bash
git add packages/masumi/scripts/register-e2e.ts packages/masumi/scripts/measure-health.ts docs/spikes/p4-spike-results.md
git commit -m "feat(masumi): registry E2E and health-check interval measurement scripts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Escrow E2E script (pass and auto-refund, direct or via gateway)

**Files:**
- Create: `packages/masumi/scripts/escrow-e2e.ts`

**Interfaces:**
- Consumes: `createPaymentRequest`, `resolvePayment`, `toPaymentState`, `submitResult`, `createPurchase`, `getPurchaseState`, `mip004`, `jcsFlat`, `parseStartJob`. In gateway mode, also P1's `POST /a/:apiId/start_job`.
- Produces: the final JSON line `{"mode","ok","terms","events":{"payment_request_created","purchase_created","funds_locked","result_submitted","withdrawn_to_seller"|"refund_withdrawn"}}` and exit code 0/1.

- [ ] **Step 1: Write `scripts/escrow-e2e.ts`**

```ts
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { masumiConfigFromEnv } from "../src/config.js";
import { MASUMI_ESCROW_UNIT } from "../src/constants.js";
import { createPaymentRequest, resolvePayment, submitResult, toPaymentState } from "../src/payments.js";
import { createPurchase, getPurchaseState } from "../src/purchases.js";
import { loadRootEnv } from "./env.js";
import { jcsFlat, mip004, parseStartJob, type StartJobTerms } from "./lib.js";

loadRootEnv();
const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    agent: { type: "string" },
    gateway: { type: "string" },
    "seller-address": { type: "string" },
    "wait-collect": { type: "boolean", default: false },
  },
});
const mode = values.mode;
if (mode !== "pass" && mode !== "fail") throw new Error("--mode pass|fail is required");
const c = masumiConfigFromEnv();
const start = Date.now();
const events: Record<string, string> = {};
const log = (message: string) => console.log(`${new Date().toISOString()} +${Math.round((Date.now() - start) / 1000)}s ${message}`);
const mark = (event: string) => {
  if (events[event]) return;
  events[event] = new Date().toISOString();
  log(event);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const purchaser = randomBytes(10).toString("hex");
const input = { symbol: "ADA" };
const inputHash = mip004(purchaser, jcsFlat(input));

type Terms = Omit<StartJobTerms, "jobId" | "identifierFromPurchaser">;
let terms: Terms;
if (values.gateway) {
  const response = await fetch(`${values.gateway.replace(/\/+$/, "")}/start_job`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input_data: input, identifier_from_purchaser: purchaser }),
  });
  if (!response.ok) throw new Error(`start_job ${response.status}: ${await response.text()}`);
  const job = parseStartJob((await response.json()) as Record<string, unknown>);
  if (job.identifierFromPurchaser !== purchaser) throw new Error("start_job echoed another identifier_from_purchaser");
  if (job.inputHash !== inputHash) throw new Error("start_job input_hash is not MIP-004 of our input");
  log(`job_id=${job.jobId}`);
  terms = job;
} else {
  if (!values.agent) throw new Error("--agent <agentIdentifier> (direct mode) or --gateway <apiBaseUrl>");
  const now = Date.now();
  const payment = await createPaymentRequest(c, {
    agentIdentifier: values.agent,
    inputHash,
    identifierFromPurchaser: purchaser,
    payByTime: new Date(now + 10 * 60_000),
    submitResultTime: new Date(now + 20 * 60_000),
    ...(values["seller-address"] ? { sellerReturnAddress: values["seller-address"] } : {}),
  });
  terms = { ...payment, agentIdentifier: values.agent, inputHash };
}
const bc = terms.blockchainIdentifier;
mark("payment_request_created");
log(`submitResultTime=${terms.submitResultTime.toISOString()} unlockTime=${terms.unlockTime.toISOString()}`);

const seller = await resolvePayment(c, bc);
const price = seller.RequestedFunds.find((f) => f.unit === MASUMI_ESCROW_UNIT);
if (!price) throw new Error(`payment is not priced in Masumi tUSDM (${MASUMI_ESCROW_UNIT}): ${JSON.stringify(seller.RequestedFunds)}`);
const { purchaseId } = await createPurchase(c, {
  agentIdentifier: terms.agentIdentifier,
  blockchainIdentifier: bc,
  inputHash: terms.inputHash,
  identifierFromPurchaser: purchaser,
  sellerVKey: terms.sellerVKey,
  payByTime: terms.payByTime,
  submitResultTime: terms.submitResultTime,
  unlockTime: terms.unlockTime,
  externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
  amountMicros: BigInt(price.amount),
});
mark("purchase_created");
log(`purchaseId=${purchaseId} price=${Number(price.amount) / 1e6} Masumi tUSDM sellerReturnAddress=${seller.sellerReturnAddress ?? "none"}`);

const hardStop =
  mode === "fail"
    ? terms.submitResultTime.getTime() + 30 * 60_000
    : values["wait-collect"]
      ? terms.unlockTime.getTime() + 20 * 60_000
      : terms.submitResultTime.getTime();
let submitted = false;
let lastLine = "";
for (;;) {
  const detail = await resolvePayment(c, bc);
  const sellerState = toPaymentState(detail.onChainState);
  const buyerState = await getPurchaseState(c, bc);
  const line = `payment=${sellerState} purchase=${buyerState} next=${detail.NextAction.requestedAction}${detail.NextAction.errorNote ? ` error=${detail.NextAction.errorNote}` : ""}`;
  if (line !== lastLine) log(line);
  lastLine = line;
  if (sellerState === "FundsLocked") mark("funds_locked");
  if (mode === "pass" && sellerState === "FundsLocked" && !submitted && !values.gateway) {
    await submitResult(c, bc, mip004(purchaser, JSON.stringify({ price: "0.42", symbol: "ADA" })));
    submitted = true;
    mark("result_submit_sent");
  }
  if (sellerState === "ResultSubmitted") {
    mark("result_submitted");
    if (mode === "pass" && !values["wait-collect"]) break;
  }
  if (sellerState === "Withdrawn") {
    mark("withdrawn_to_seller");
    break;
  }
  if (sellerState === "RefundWithdrawn" || buyerState === "RefundWithdrawn") {
    mark("refund_withdrawn");
    break;
  }
  if (Date.now() > hardStop) {
    log("timed out");
    break;
  }
  await sleep(20_000);
}

const ok =
  mode === "pass"
    ? Boolean(events.result_submitted) && (!values["wait-collect"] || Boolean(events.withdrawn_to_seller))
    : Boolean(events.refund_withdrawn) && !events.result_submitted;
console.log(
  JSON.stringify({
    mode,
    ok,
    purchaser,
    blockchainIdentifier: `${bc.slice(0, 32)}…`,
    terms: {
      payByTime: terms.payByTime.toISOString(),
      submitResultTime: terms.submitResultTime.toISOString(),
      unlockTime: terms.unlockTime.toISOString(),
    },
    events,
  }),
);
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @hirakumi/masumi typecheck`
Expected: exit 0.

- [ ] **Step 3: Live run in direct mode against the spike agent (both modes in parallel, ~35 min)**

```bash
export PAYMENT_SERVICE_URL=http://localhost:3001/api/v1
pnpm --filter @hirakumi/masumi escrow-e2e --mode fail --agent $SPIKE_AGENT_ID > /tmp/escrow-fail.log 2>&1 &
pnpm --filter @hirakumi/masumi escrow-e2e --mode pass --agent $SPIKE_AGENT_ID --seller-address $SELLER_DEMO_ADDRESS --wait-collect > /tmp/escrow-pass.log 2>&1 &
wait; tail -n 1 /tmp/escrow-fail.log /tmp/escrow-pass.log
```

Expected last lines:
- `{"mode":"fail","ok":true,…,"events":{"payment_request_created":…,"purchase_created":…,"funds_locked":…,"refund_withdrawn":…}}`;
- `{"mode":"pass","ok":true,…,"events":{…,"funds_locked":…,"result_submit_sent":…,"result_submitted":…,"withdrawn_to_seller":…}}`.

`refund_withdrawn` comes 10–15 min after `terms.submitResultTime`.

- [ ] **Step 4: Commit**

```bash
git add packages/masumi/scripts/escrow-e2e.ts
git commit -m "feat(masumi): escrow E2E (pass + auto-refund), direct or via gateway start_job" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Deploy gateway and coworker to EC2 (as soon as P1/P3 have a `start` script)

**Files:** none new (uses `docker-compose.yml`, `deploy/app.Dockerfile`)

**Interfaces:**
- Consumes: `apps/gateway` (listens on `0.0.0.0:${GATEWAY_PORT}`), `apps/coworker`, `db/migrations/0001_init.sql` (P1), and the server `.env`.
- Produces: `https://$PUBLIC_DOMAIN/a/:apiId/*` served by the gateway.

- [ ] **Step 1: Apply P1's schema once**

Run: `EIP=$EIP deploy/deploy.sh postgres` (syncs `db/`), then:

```bash
ssh -i ~/.ssh/hirakumi.pem ubuntu@$EIP bash -s <<'EOF'
cd /opt/hirakumi
psql() { docker compose exec -T postgres psql -U hirakumi -d hirakumi -v ON_ERROR_STOP=1 "$@"; }
if [ -z "$(psql -tAc "select to_regclass('public.apis')")" ]; then psql < db/migrations/0001_init.sql; fi
psql -tAc "select count(*) from information_schema.tables where table_schema='public'"
EOF
```

Expected: `12` (the contract's tables).

- [ ] **Step 2: Build and start the gateway and coworker**

Run: `EIP=$EIP deploy/deploy.sh gateway coworker caddy`
Expected: `gateway` and `coworker` are `running`, with no restart loop: `docker compose ps` shows the same `Up` duration on two runs 30 s apart.

- [ ] **Step 3: Verify through Caddy**

Run: `curl -sS -o /dev/null -w '%{http_code}\n' https://api.hirakumi.app/a/does-not-exist/availability`
Expected: a gateway answer (`404`, or `503` per P1), not `502` (a Caddy upstream failure).

---

### Task 17: Hour-16 checkpoint: escrow pass + auto-refund, registry Online, Offline flip

**Files:** append the results to `docs/spikes/p4-spike-results.md` under a `## Hour 16` heading.

**Interfaces:**
- Consumes: a live demo API in `apis` (P5's price-api, onboarded by hand or by the coworker), the gateway's MIP-003 routes, and the monitor's `DEMO_MODE=1`.
- Produces: the `agent_identifier` of the demo API, and the checkpoint verdict posted to team chat.

- [ ] **Step 1: Smoke**

Run: `PAYMENT_SERVICE_URL=http://localhost:3001/api/v1 pnpm --filter @hirakumi/masumi smoke`
Expected: exit 0.

- [ ] **Step 2: Register the demo API (skip if the coworker already did) and store the identifier**

Run: `pnpm --filter @hirakumi/masumi register-e2e --name "ADA Price API (Hirakumi)" --description "ADA price; buyers only pay for responses that pass the published promise" --url https://api.hirakumi.app/a/<apiId> --price <escrow_price_micros> --tag hirakumi --tag prices`
Expected: `AGENT_IDENTIFIER=<id>` and `registry=Online`.

Then: `ssh … "cd /opt/hirakumi && docker compose exec -T postgres psql -U hirakumi -d hirakumi -c \"update apis set agent_identifier='<id>', state='live' where id='<apiId>'\""`
Expected: `UPDATE 1`.

- [ ] **Step 3: Check `/availability` is registry-safe**

Run: `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://api.hirakumi.app/a/<apiId>/availability && curl -sS https://api.hirakumi.app/a/<apiId>/availability | jq -c '{status, type, hasAgentIdentifier: has("agentIdentifier")}'`
Expected: `200 ` then `{"status":"available","type":"masumi-agent","hasAgentIdentifier":false}`. If `hasAgentIdentifier` is true, its value must equal `<id>` exactly, or the registry marks the agent Invalid permanently.

- [ ] **Step 4: Offline flip**

P5 turns on the price-api break switch (`{}` mode). Within 20 s (demo mode), `curl -s -o /dev/null -w '%{http_code}\n' https://api.hirakumi.app/a/<apiId>/availability` prints `503`. Then run `pnpm --filter @hirakumi/masumi measure-health --agent <id> --refresh`.
Expected: `refresh → Offline in <ms> ms`. Switch the break off. After 2 passing probes, `/availability` returns 200 and `--refresh` prints `Online`.

- [ ] **Step 5: Escrow through the gateway**

```bash
pnpm --filter @hirakumi/masumi escrow-e2e --mode pass --gateway https://api.hirakumi.app/a/<apiId> > /tmp/h16-pass.log 2>&1 &
# P5 switches the break ON before this second job so the gateway's rule check fails and it submits nothing
pnpm --filter @hirakumi/masumi escrow-e2e --mode fail --gateway https://api.hirakumi.app/a/<apiId> > /tmp/h16-fail.log 2>&1 &
wait; tail -n 1 /tmp/h16-pass.log /tmp/h16-fail.log
```

Expected: both lines `"ok":true`. The pass line has `result_submitted` (submitted by the gateway). The fail line has `refund_withdrawn` and no `result_submitted`.

If `start_job` is not ready at hour 16, run the same two commands with `--agent <id>` instead of `--gateway …` (direct mode). That still proves escrow + auto-refund for the registered agent. Tell P1 the gateway path is outstanding.

- [ ] **Step 6: Post the verdict** ("Hour 16: escrow pass ✔/✘, auto-refund ✔/✘ (minutes), registry Online ✔/✘, Offline flip ✔/✘ (seconds)") to team chat. Commit `docs/spikes/p4-spike-results.md`:

```bash
git add docs/spikes/p4-spike-results.md
git commit -m "docs(spike): hour-16 Masumi checkpoint results" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Fallbacks (switch if a path is still blocked 3 hours after its spike started)

**Files:** none in the repo. Uses a clone of https://github.com/cardano-foundation/x402-cardano-demo.

**Interfaces:**
- Consumes: the node selling wallet's mnemonic (password manager, or `GET /wallet?walletType=Selling&id=<id>&includeSecret=true` → `data.Secret.mnemonic`).
- Produces: an `agent_identifier` minted without `POST /registry`, and/or a recorded escrow video.

**Decision rule:**
- If `POST /registry` has not reached `RegistrationConfirmed` 3 hours after Task 5 started, use **A**.
- If escrow (Tasks 6 and 15) has not shown `FundsLocked`, or the pass/fail terminal states, 3 hours after Task 6 started, use **B**.
- If `REGISTRY_API_KEY` is still missing at hour 3, use **C**.

- [ ] **Step 1 (A): Direct on-chain registration with the demo's register script**

```bash
git clone --depth 1 https://github.com/cardano-foundation/x402-cardano-demo.git ~/x402-cardano-demo
cd ~/x402-cardano-demo/masumi && npm install
cat > .env <<'EOF'
BLOCKFROST_PROJECT_ID=<preprod project id>
SELLER_MNEMONIC=<node SELLING wallet mnemonic>
AGENT_PUBLIC_URL=https://api.hirakumi.app/a/<apiId>
PRICE_TUSDM_UNITS=<escrow_price_micros>
AGENT_NAME=ADA Price API (Hirakumi)
AGENT_DESCRIPTION=ADA price; buyers only pay for responses that pass the published promise
AGENT_TAGS=hirakumi,prices
EOF
chmod 600 .env
npm run register
```

Expected: `seller addr_test1…`, `Submitted <txHash>`, `MASUMI_AGENT_IDENTIFIER=67ab0c92…` (120 hex). The script mints V2 metadata with the same escrow address and the concatenated Masumi tUSDM unit that the payment service writes. Because the mnemonic is the node's selling wallet, the NFT holder's payment key hash is the node's `walletVkey`, so `POST /payment` still finds the selling wallet.

- [ ] **Step 2 (A): Verify the node accepts the externally minted agent**

Compare the payment key hash: `printed seller address` vs `GET /wallet/list?walletType=Selling` `walletAddress`. They must be the same address, or at least share the payment part (Cardanoscan shows "Payment credential" for each). Then run `pnpm --filter @hirakumi/masumi escrow-e2e --mode pass --agent <MASUMI_AGENT_IDENTIFIER>` and expect `"ok":true`. Store the identifier with the SQL from Task 17 step 2.

- [ ] **Step 3 (B): Pre-recorded escrow demo**

Record the best working evidence, in this order of preference:
1. `escrow-e2e --mode pass --wait-collect` and `--mode fail`, run in a terminal recording (`asciinema rec /tmp/escrow.cast`) with Cardanoscan tabs for the lock, result and refund txs. Hand the recording to P5.
2. If the payment service cannot lock at all: the x402-cardano-demo Masumi agent (`npm run agent`, its README sections 3–6) to record lock → result → `npm run collect` on the real Masumi escrow. Disclose on screen that the auto-refund branch is "Masumi node behaviour, not shown live" and cite `automatic-decisions/service.ts` (refund when no result 10 min after `submitResultTime`).

Post to team chat: "Escrow is pre-recorded (fallback B)". P1 then keeps `start_job` behind `DEMO_MODE` and P5 updates the 2:25 segment.

- [ ] **Step 4 (C): Registry status without a key**

Set `REGISTRY_API_KEY=` (empty). `getRegistryStatus` then throws `MasumiInputError`, and P3's coworker must treat `registering → live` as "minted (`getAgentIdentifier` non-null) and our own `/availability` is 200". Disclose it in the dashboard copy ("registry status shown by Masumi Explorer"). Show the Offline flip in the demo with the stub log line (`… GET /availability … -> 503`) plus a screenshot from https://www.masumi.network/agent-explorer, which is unverified for preprod: check it once and record what it shows.

---

## Self-Review

**Spec and brief coverage:**
- EC2 ap-southeast-1, instance type, SG 80/443/22, Elastic IP, DNS A record: Task 2.
- Docker + compose install: Task 2 `user-data.sh`.
- Production compose (postgres, payment service + its db, gateway, coworker, caddy) and Caddyfile: Task 1 (payment service db = `masumi` in the same Postgres, created by `postgres-init`).
- Wallet funding with both tUSDM tokens, purchasing wallet, demo escrow buyer: Task 4. It also corrects which wallet pays mints.
- Payment service setup on preprod (admin key, payment source, selling + purchasing wallets, collection): Task 3. Seller-address collection: investigated in source and proved live in Task 6 step 5.
- `packages/masumi` with the exact contract API and mocked-fetch vitest tests: Tasks 9–12. Live smoke script: Task 13.
- Registry registration E2E for one API: Tasks 5, 14, 17.
- 503 → Offline proof and interval measurement: Task 5 steps 4–6, Task 14 step 3, Task 17 step 4.
- Escrow E2E pass + no-submit auto-refund with the Masumi tUSDM unit: Tasks 6, 15, 17.
- `POST /payment/x402` findings: verified in source (facts table) and live in Task 7.
- Spike first (hours 0–2) with exact commands and a record: Tasks 1–8.
- Hour-16 checkpoint: Task 17. Fallback after 3 h: Task 18.

**Placeholder scan:** The angle-bracket values are operator inputs (`<EIP>`, `<apiId>`, `<escrow_price_micros>`, mnemonics, measured numbers in the spike table). Each is produced by a named earlier step or by another workstream. No TBD/TODO. Every code step has complete code.

**Type consistency:**
- `MasumiConfig`, `PaymentState`, `RegistryStatus` are defined once in `types.ts` and used everywhere.
- `createPaymentRequest` returns `sellerVKey` (contract casing), and `createPurchase` sends `sellerVkey` (node casing). Both are tested.
- Times: ISO strings in to `/payment`, unix-ms strings in to `/purchase`, `Date` in the TypeScript API. Tested in `payments.test.ts` and `purchases.test.ts`.
- `paymentDto` fixture is exported from `payments.test.ts` and reused in `purchases.test.ts`, so the two stay in sync.
- `StartJobTerms` is defined in `scripts/lib.ts` and used by `escrow-e2e.ts`.

**Known risks still open (each has a check):**
- `ez.dateIn` with millisecond ISO strings (Task 6 step 2 has the fallback format).
- The seed working in `node:20-bookworm` (Task 3 step 4).
- The registry key source (Task 5 step 1, fallback C).
- The real registry check interval on a busy preprod registry (Task 5).
- vitest 5's need for a `vite` peer (pinned in `package.json`).
- The gateway `start_job` field names (contract delta 6; direct mode as fallback).
