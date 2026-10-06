# Hirakumi: shared contract (read before any workstream plan)

> **For agentic workers:** this file defines the interfaces between the five workstream plans (`2026-10-06-hirakumi-p1-gateway.md` … `-p5-demo.md`). If your plan and this contract disagree, this contract wins. Changing the contract requires telling all five owners.

**Spec:** `docs/superpowers/specs/2026-10-06-hirakumi-design.md` (v4)

## Global constraints

- Network: **`cardano:preprod` only**. Reject any address that does not start with `addr_test1`.
- **All `@x402/*` packages pinned to exactly `2.26.0`** (track content freeze). Never `^`.
- Node **22** or newer, TypeScript, ESM (`"type": "module"`), `tsx` to run, **vitest** for tests.
- Package manager: **pnpm** workspaces.
- Facilitator (hosted, preprod): `https://x402.preprod.dev.ecosyseng.cf-deployments.org`. Local fallback: `npm run facilitator` from the x402-express template, port 4022.
- **Two different preprod USDM tokens. Do not mix them up:**
  - **Pack payments (x402):** `USDM_PREPROD_ASSET` exported by `@x402/cardano` = `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d`. Claim at https://tusdm.moneta.global.
  - **Escrow jobs (Masumi):** policy `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde`, asset name `0014df10745553444d`. Unit = concatenation. Payment service `PAYMENT_UNIT`.
- Both tokens have 6 decimals. Store every amount as integer **micros** (`bigint` in SQL, `string` in JSON).
- Upstream limits: 15s timeout, 256 KB request, 1 MB response, no redirects, HTTPS only (except `http://localhost` when `ALLOW_INSECURE_UPSTREAM=1`).
- Monitor: production 120s interval, 3 fails → down, 2 passes → healthy. **Demo mode** (`DEMO_MODE=1`): 10s, 2 fails, 2 passes.
- Copy rule: user-facing text is plain English. Say "promise" for the acceptance rule, "credits" for pack calls, "Live / Down" for health.

## Repository layout

```
token2049/
  package.json              # pnpm workspace root, scripts: test, typecheck
  pnpm-workspace.yaml       # packages: ["apps/*", "packages/*", "sellers/*", "agents/*", "cre/*"]
  tsconfig.base.json
  docker-compose.yml        # P4: postgres, payment-service, gateway, coworker, caddy
  Caddyfile                 # P4
  .env.example              # every variable below
  db/migrations/0001_init.sql   # this contract, owned by P1
  packages/core/            # P1: rule engine, hashing, safeFetch, challenge, tokens
  packages/db/              # P1: postgres client + typed query helpers
  packages/masumi/          # P4: payment-service + registry client
  apps/gateway/             # P1
  apps/web/                 # P2 (Next.js, Vercel)
  apps/coworker/            # P3
  sellers/price-api/        # P5
  agents/buyer/             # P5
  cre/scorer/               # P5 (stretch)
```

## Environment variables (`.env.example`)

```
# shared
DATABASE_URL=postgres://hirakumi:hirakumi@localhost:5432/hirakumi
PUBLIC_BASE_URL=https://api.hirakumi.app        # Caddy domain serving the gateway
INTERNAL_TOKEN=change-me-32-bytes                # bearer for /internal/* routes
DEMO_MODE=0
ALLOW_INSECURE_UPSTREAM=0
# gateway
FACILITATOR_URL=https://x402.preprod.dev.ecosyseng.cf-deployments.org
GATEWAY_PORT=4021
# masumi payment service
PAYMENT_SERVICE_URL=http://payment-service:3001/api/v1
PAYMENT_SERVICE_TOKEN=
MASUMI_ESCROW_UNIT=16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d
BLOCKFROST_PROJECT_ID=preprod...
# coworker
ANTHROPIC_API_KEY=
SOKOSUMI_API_URL=https://api.preprod.sokosumi.com
SOKOSUMI_COWORKER_API_KEY=                        # empty → dashboard-chat fallback
WEB_BASE_URL=https://hirakumi.vercel.app
# demo
BUYER_MNEMONIC=
SELLER_DEMO_ADDRESS=addr_test1...
```

## Database (`db/migrations/0001_init.sql`, P1 creates it in Task 1)

```sql
create table sellers (
  id text primary key,                         -- 'sel_' + 10 random base32
  cardano_addr text not null unique check (cardano_addr like 'addr_test1%'),
  sokosumi_user_id text,
  created_at timestamptz not null default now()
);
create table apis (
  id text primary key,                         -- 'api_' + 10 random base32
  seller_id text not null references sellers(id),
  name text not null,
  origin text not null,                        -- e.g. https://price.example.dev
  path_prefix text not null default '/',
  openapi_url text not null,
  openapi_sha256 text,
  state text not null default 'intake' check (state in
    ('intake','parsed','described','endpoints_confirmed','ownership_verified',
     'rule_built','priced','registering','live','retired')),
  health text not null default 'healthy' check (health in ('healthy','down')),
  health_checked_at timestamptz,
  escrow_op_id text,
  agent_identifier text,
  sokosumi_task_id text,
  created_at timestamptz not null default now()
);
create table onboard_steps (
  api_id text not null references apis(id),
  step text not null,
  status text not null check (status in ('pending','running','done','failed','waiting_seller')),
  attempts int not null default 0,
  output jsonb,
  updated_at timestamptz not null default now(),
  primary key (api_id, step)
);
create table challenges (
  id text primary key,
  api_id text not null references apis(id),
  kind text not null check (kind in ('http','wallet')),
  token text not null,                         -- http: file contents; wallet: nonce
  expires_at timestamptz not null,
  consumed_at timestamptz,
  proof jsonb
);
create table operations (
  id text primary key,                         -- 'op_' + 10 random base32
  api_id text not null references apis(id),
  op_id text not null,                         -- OpenAPI operationId (or METHOD_path slug)
  method text not null,
  path text not null,
  input_schema jsonb not null,
  description text,
  side_effects_likely boolean not null default false,
  side_effects_confirmed_none boolean not null default false,
  enabled boolean not null default false,
  unique (api_id, op_id)
);
create table rules (
  id text primary key,
  operation_id text not null references operations(id),
  version int not null,
  definition jsonb not null,                   -- RuleDefinition
  hash text not null,                          -- 'sha256:<hex>' of jcs(definition); identical rules may repeat
  plain_english text,
  created_at timestamptz not null default now(),
  unique (operation_id, version)
);
create table packs (
  id text primary key,                         -- 'pk_' + 10 random base32
  api_id text not null references apis(id),
  calls int not null check (calls > 0),
  price_micros bigint not null check (price_micros >= 1000000),
  escrow_price_micros bigint not null check (escrow_price_micros >= 1000000)
);
create table credit_tokens (
  id text primary key,
  api_id text not null references apis(id),
  pack_id text not null references packs(id),
  token_hash text not null unique,             -- sha256 hex of the bearer token
  payer text,
  status text not null check (status in ('pending','active','exhausted','revoked')),
  remaining int not null,
  payment_payload_hash text not null unique,
  tx_hash text,
  created_at timestamptz not null default now()
);
create table calls (
  id text primary key,
  kind text not null check (kind in ('credit','escrow','probe','preview')),
  credit_token_id text references credit_tokens(id),
  job_id text,
  blockchain_id text,
  api_id text not null references apis(id),
  op_id text not null,
  rule_id text references rules(id),
  execution text not null check (execution in ('upstream_ok','upstream_error','timeout','blocked')),
  verdict text not null check (verdict in ('pass','fail','n/a')),
  verdict_reasons jsonb not null default '[]',
  latency_ms int,
  input_hash text,
  output_hash text,
  created_at timestamptz not null default now()
);
create table jobs (
  id text primary key,                         -- MIP-003 job_id
  api_id text not null references apis(id),
  identifier_from_purchaser text not null,
  input jsonb not null,
  input_hash text not null,
  blockchain_identifier text,
  status text not null check (status in
    ('awaiting_payment','running','completed','failed','expired')),
  output text,
  output_hash text,
  failure_reasons jsonb,
  pay_by_time timestamptz,
  submit_result_time timestamptz,
  created_at timestamptz not null default now()
);
create table test_inputs (
  id text primary key,
  operation_id text not null references operations(id),
  input jsonb not null
);
create table health_events (
  id bigserial primary key,
  api_id text not null references apis(id),
  from_health text not null,
  to_health text not null,
  reasons jsonb not null default '[]',
  at timestamptz not null default now(),
  notified_at timestamptz
);
create index on rules (hash);
create index on calls (api_id, created_at desc);
create index on health_events (notified_at) where notified_at is null;
```

**Write ownership:**
- web writes `sellers`, `challenges(kind='wallet')`, the seller-confirmation columns of `operations`, `packs`, and `apis.state` transitions caused by seller clicks (marked **[web]** below).
- The coworker writes the other `apis.state` transitions, `onboard_steps`, `rules`, `test_inputs`, and `operations` from parsing.
- The gateway writes `credit_tokens`, `calls`, `jobs`, `apis.health*`, and `health_events`.

## State machine (`apis.state`), who advances it

| From → To | Actor | Trigger |
|---|---|---|
| (new) → intake | web or coworker | seller submits OpenAPI URL |
| intake → parsed | coworker | `parseOpenApi` succeeds |
| parsed → described | coworker | LLM describe step done |
| described → endpoints_confirmed | **[web]** | seller ticks ≥1 endpoint and picks `escrow_op_id` |
| endpoints_confirmed → ownership_verified | **[web]** | HTTP challenge passed (via gateway `/internal/challenge`) and wallet signature verified |
| ownership_verified → rule_built | coworker | QA infers and saves a rule per enabled op |
| rule_built → priced | **[web]** | seller saves pack + escrow price |
| priced → registering | **[web]** | seller clicks Publish |
| registering → live | coworker | registry shows Online for `agent_identifier` |
| live → retired | **[web]** | seller deletes |

## `packages/core` API (P1 implements; everyone imports `@hirakumi/core`)

```ts
// rules.ts
export type RuleDefinition = {
  version: 1;
  status: { min: number; max: number };        // e.g. {min:200,max:299}
  contentType: "application/json";
  schema: Record<string, unknown>;             // JSON Schema draft 2020-12; may use keyword maxAgeSeconds
};
export type Verdict = { pass: boolean; reasons: string[] };
export type CompiledRule = { hash: string; check(res: UpstreamResult): Verdict };
export function compileRule(def: RuleDefinition): CompiledRule;   // cached by hash
export function ruleHash(def: RuleDefinition): string;            // 'sha256:' + hex(sha256(jcs(def)))
export function inferRule(samples: unknown[], errorSample?: unknown): RuleDefinition;
// maxAgeSeconds: on a string property (ISO 8601 or epoch-seconds number), fails when now - value > N

// hashing.ts (MIP-004)
export function inputHash(identifier: string, input: unknown): string;   // sha256(identifier + ';' + jcs(input)) hex
export function outputHash(identifier: string, raw: string): string;     // sha256(identifier + ';' + raw) hex

// fetch.ts
export type UpstreamResult = { status: number; contentType: string | null; body: string; latencyMs: number };
export class UpstreamBlockedError extends Error {}
export function safeFetch(url: string, init: { method: string; headers?: Record<string,string>; body?: string },
                          opts?: { timeoutMs?: number; maxBytes?: number }): Promise<UpstreamResult>;
// throws UpstreamBlockedError for private/loopback/link-local/metadata IPs, redirects, non-https

// challenge.ts
export type WalletChallengeFields = { domain: string; sellerId: string; apiId: string; origin: string;
  payTo: string; network: "cardano:preprod"; nonce: string; expires: string };
export function buildWalletChallenge(f: WalletChallengeFields): string;   // plain-text, line-based, stable order
export function httpChallengePath(apiId: string): string;               // '/.well-known/hirakumi/<apiId>.txt'

// ids.ts
export function newId(prefix: "sel" | "api" | "op" | "pk" | "ct" | "call" | "job" | "rule" | "ch" | "ti"): string;
export function newBearerToken(): string;        // 'hk_' + 32 random bytes base64url
export function sha256Hex(s: string): string;
```

## Gateway HTTP surface (P1 implements; P2, P3 and P5 call it)

**Public** (behind Caddy at `PUBLIC_BASE_URL`):

| Route | Behaviour |
|---|---|
| `GET\|POST /a/:apiId/x/:opId` | No `Authorization: Bearer hk_…`: input check → 400 / 503 / **402** with JSON `{ error: "credits_required", packs: [{packId, calls, price, asset, buyUrl}], ruleHash, ruleUrl }`. With a valid token: reserve → proxy → rule → **200** (header `X-Credits-Remaining`) or **422** `{ error: "promise_not_met", reasons }`, **502**, **504** |
| `POST /a/:apiId/packs/:packId` | x402-protected (`exact`, `cardano:preprod`, asset `USDM_PREPROD_ASSET`, `payTo` = seller address, `extra: {apiId, packId, calls, ruleHash}`). The 200 body `{ token, credits, apiId }` becomes usable only after `onAfterSettle` |
| `POST /a/:apiId/start_job` | MIP-003 |
| `GET /a/:apiId/status?job_id=` | MIP-003 |
| `GET /a/:apiId/availability` | MIP-003. **200** `{status:"available", type:"masumi-agent", message}`, or **503** `{status:"unavailable", message, estimated_downtime_seconds}` |
| `GET /a/:apiId/input_schema` | MIP-003, for `escrow_op_id` |
| `GET /r/:ruleHash` | Rule JSON plus `plain_english` |

**Internal** (header `Authorization: Bearer ${INTERNAL_TOKEN}`):

| Route | Body → Response |
|---|---|
| `POST /internal/preview/:apiId/:opId` | `{ input }` → `UpstreamResult & { verdict?: Verdict }`. Unpaid test call; logs `calls.kind='preview'` |
| `POST /internal/challenge/:apiId/check` | → `{ ok: boolean, triedUrl: string, detail: string }` (fetches `origin + httpChallengePath`, compares to the `challenges` row with kind http) |
| `POST /internal/apis/:apiId/reload` | Drops cached rules/prices/health for that API |
| `GET /internal/apis/:apiId/health` | → `{ health, checkedAt, lastReasons }` |

## `packages/masumi` API (P4 implements; P1 and P3 call it)

```ts
export type MasumiConfig = { baseUrl: string; token: string; network: "Preprod" };
export function registerAgent(c: MasumiConfig, a: { name: string; description: string; apiBaseUrl: string;
  priceMicros: bigint; unit: string; tags: string[]; exampleOutput?: string }):
  Promise<{ registrationId: string }>;
export function getAgentIdentifier(c: MasumiConfig, registrationId: string): Promise<string | null>; // null until minted
export function getRegistryStatus(c: MasumiConfig, agentIdentifier: string): Promise<"Online"|"Offline"|"Deregistered"|"Invalid"|"Unknown">;
export function createPaymentRequest(c: MasumiConfig, p: { agentIdentifier: string; inputHash: string;
  identifierFromPurchaser: string; submitResultTime: Date; payByTime: Date }):
  Promise<{ blockchainIdentifier: string; payByTime: Date; submitResultTime: Date; unlockTime: Date;
            externalDisputeUnlockTime: Date; sellerVKey: string }>;
export function getPaymentState(c: MasumiConfig, blockchainIdentifier: string):
  Promise<"WaitingForPayment"|"FundsLocked"|"ResultSubmitted"|"RefundRequested"|"Disputed"|"Withdrawn"|"RefundWithdrawn"|"Other">;
export function submitResult(c: MasumiConfig, blockchainIdentifier: string, resultHash: string): Promise<void>;
// demo buyer side (same node, purchasing wallet)
export function createPurchase(c: MasumiConfig, p: { agentIdentifier: string; blockchainIdentifier: string;
  inputHash: string; identifierFromPurchaser: string; sellerVKey: string; payByTime: Date; submitResultTime: Date;
  unlockTime: Date; externalDisputeUnlockTime: Date; amountMicros: bigint }): Promise<{ purchaseId: string }>;
```

P4 verifies the exact payment-service field names against the live OpenAPI at `${PAYMENT_SERVICE_URL}/docs` in its spike, and keeps this TypeScript signature stable, adapting only the internals.

## Checkpoints (whole team)

| Hour | Gate | If missed |
|---|---|---|
| 2 | Spike results posted in team chat; Sokosumi coworker key obtained? | P3 builds the dashboard-chat coworker |
| 10 | Packs → credits → pass (200) / fail (422) / down (503) on preprod, onboarding done by hand in SQL | Everyone helps P1 |
| 16 | Escrow pass and auto-refund on preprod; registry registration Online; monitor flips `/availability` | Escrow becomes pre-recorded demo only |
| 18 | Coworker drives onboarding end to end. **CRE gate:** start only if the 10h and 16h gates passed | P5 skips CRE |
| 22 | Feature freeze | — |

---

## Contract v1.1 amendments (reconciled from all five plans, 6 Oct 2026)

These override the sections above and any plan text that disagrees.

### Database
- **D1.** `rules.hash` is **not unique** (identical rules can be inferred for two operations). `0001_init.sql` has a plain index on `rules (hash)`. `GET /r/:ruleHash` returns the first match; identical hashes mean identical JSON.
- **D2.** `db/migrations/0002_coworker.sql` (owned by **P3**) adds `coworker_tasks` and **`messages`**, the single shared chat table, with `seller_id` and `handled_at` for P2. **P2 does not create `0002_chat.sql`** and has no `chat_messages` table.
- **D3.** Web (P2) writes `challenges` rows of **both** kinds (`http` and `wallet`). The gateway only reads `http` rows and compares them trimmed.
- **D4.** `apis.escrow_op_id` stores the OpenAPI **`op_id`** (e.g. `getPrice`), not the `operations.id`.
- **D5.** `health_events.reasons` is `[{ op: string, reason: string, since: string /* ISO */ }]`.
- **D6.** On failure the coworker writes `onboard_steps.output = { error: string }`. Web may reset a `failed` step back to `pending` and may write seller-supplied samples into `test_inputs`.
- **D7.** `calls.kind = 'probe'` for monitor probes; `'preview'` for `/internal/preview`.

### Gateway behaviour
- **G1.** Operation `input_schema` is a **flat JSON Schema object** for the request (query params and/or JSON body merged into one object). ajv runs with `strict: false`.
- **G2.** A pack's `extra.ruleHash` is the rule hash of the API's **escrow operation**.
- **G3.** The same `PAYMENT-SIGNATURE` replayed answers **409** `{ error: "payment_already_used" }` (the raw token can't be returned again because only its hash is stored).
- **G4.** Credit route auth errors: **401** `{ error: "invalid_token" }` for an unknown or revoked token; **401** `{ error: "token_pending" }` while settlement is pending.
- **G5.** `X-Credits-Remaining` is sent on 200 **and** on 422, 502 and 504.
- **G6.** `POST /internal/preview` returns **200** whatever the upstream status; the upstream status is inside the body.
- **G7.** `POST /a/:apiId/start_job` request: `{ identifier_from_purchaser: string, input_data: object }`. Response 200:
  `{ id, job_id, status: "awaiting_payment", blockchainIdentifier, payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime, agentIdentifier, sellerVKey, identifierFromPurchaser, input_hash, amounts: [{ amount: string /* micros */, unit: string /* MASUMI_ESCROW_UNIT */ }] }`.
  **All four times are epoch-millisecond numbers** (P5's buyer must read numbers, not strings). `amounts` is required; P1 adds it.
- **G8.** `submitResult` sends the **output hash only**, as exactly 64 lowercase hex characters.

### Masumi (`packages/masumi`, P4)
- **M1.** `MasumiConfig` gains `registryUrl: string` and `registryToken: string`.
- **M2.** `createPaymentRequest` gains an optional `sellerReturnAddress?: string`. Pass the seller's verified address so escrow pays the seller directly (non-custodial).
- **M3.** New: `refreshRegistryStatus(c: MasumiConfig, agentIdentifier: string): Promise<void>`.
- **M4.** `registerAgent` throws only if nothing was created on the payment service, so it's safe to re-run.
- **M5.** Payment-service facts (from its 0.29.0 source):
  - V2 registration uses `supportedPaymentSources`.
  - The earliest `submitResultTime` is about 15 minutes out; the automatic refund lands about 10 minutes after that, so **31–35 minutes in total**. The escrow refund beat in the video must be pre-recorded early.
  - `POST /payment/x402` only builds an unsigned lock transaction; it is not a facilitator.
  - The selling wallet pays for registry mints.

### Buyers and demo (P5)
- **B1.** x402 buyers must set an explicit spend cap for USDM: `setSpendControls({ allowedAssets: [{ network: "cardano:*", asset: USDM_PREPROD_ASSET, maxAmountPerPayment: "2000000" }] })`. The default $1 cap rejects a 2 tUSDM pack.
- **B2.** The demo price API's rule uses `maxAgeSeconds` between 600 and 3000 on `timestamp`.
- **B3.** `cre/` is **not** a pnpm workspace member (CRE uses Bun). Remove it from `pnpm-workspace.yaml`.

### Web and coworker routes
- **W1.** P2 serves `/setup?t=<setup_token>` (resolves a `coworker_tasks.setup_token`) and `/apis/:apiId`.
- **W2.** Seller sign-in needs a CIP-30 signature over a login nonce. That's a fifth seller action on top of US1's four, and it is accepted.

### New environment variables
`SESSION_SECRET`, `GATEWAY_INTERNAL_URL` (web and coworker → gateway internal routes), `CHAT_FALLBACK`, `ESCROW_SWEEP_NOTICE`, `COWORKER_ONBOARDING_CREDITS`, `MASUMI_REGISTRY_URL`, `MASUMI_REGISTRY_TOKEN`, plus any listed in the P4 plan's env section.

### Decided: database hosting (6 Oct)
Vercel (web) can't reach Postgres on EC2 without exposing it to the internet. **Decision:** the Hirakumi database runs on **Neon** (managed Postgres via the Vercel Marketplace, TLS). The gateway and coworker on EC2 and the web app on Vercel all use its `DATABASE_URL`. The Masumi payment service keeps its own Postgres inside Docker on EC2. `/internal/*` stays reachable through Caddy only with `INTERNAL_TOKEN`.
