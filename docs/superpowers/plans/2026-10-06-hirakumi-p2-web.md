# Hirakumi P2 — Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Contract v1.1:** read the "Contract v1.1 amendments" section at the end of `2026-10-06-hirakumi-00-contract.md` before starting. It changes: the chat table is P3's `messages`, so don't create 0002_chat.sql (D2); the database is decided: Neon.

**Goal:** Ship `apps/web`, the Next.js seller dashboard. A seller signs in with a CIP-30 wallet, pastes an OpenAPI link (Setup), picks endpoints (Endpoints), proves ownership with a served file plus a wallet signature (Ownership), approves the promise and a price, then publishes (Review). After that she watches health, calls, pass rate and earnings with Cardanoscan links (API overview, Sales). A dashboard chat panel stands in for the coworker if Sokosumi whitelisting fails.

**Architecture:** Next.js 16 App Router on Vercel. Server components read Postgres through small repository modules (`lib/repo/*`) built on postgres.js. Every mutation is a JSON route handler under `app/api/**`. Handlers use only Web `Request`/`Response`, so vitest calls them directly. The browser never touches the database. Seller identity is an HMAC-signed `hk_session` cookie, issued after the wallet signs a login message that the server checks with `checkSignature` from `@meshsdk/core-cst`. State changes in `apis.state` are conditional `UPDATE … WHERE state IN (…)` statements, so double clicks and races cannot skip a step. Calls to the gateway's `/internal/*` routes go through one injectable client (`lib/gateway.ts`), which tests replace with a fake.

**Tech Stack:** Next.js 16.3.8, React 19.3.0, TypeScript 5.9.3, Tailwind CSS 4.3.3, shadcn CLI 4.21.2 (Button, Input, Badge), postgres 3.4.9, @meshsdk/core-cst 1.9.1, @hirakumi/core (workspace), vitest 5.0.3, vite 8.3.3, @vitejs/plugin-react 6.1.2, jsdom 30.1.2, @testing-library/react 16.3.3, @testing-library/user-event 14.6.7, @testing-library/jest-dom 7.0.1, tsx 4.23.15, @playwright/test 1.63.0 (optional smoke test). Node 22+, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-06-hirakumi-design.md` (v4)
**Contract:** `docs/superpowers/plans/2026-10-06-hirakumi-00-contract.md` (if this plan disagrees with the contract, the contract wins)

---

## Global Constraints (exact values from contract)

- Network **`cardano:preprod` only**. Reject every address that does not start with `addr_test1`. CIP-30 `getNetworkId()` must return `0`.
- The web app has no `@x402/*` dependency. The buyer snippet it prints pins **`@x402/fetch@2.26.0` and `@x402/cardano@2.26.0`** exactly.
- Node **22+**, TypeScript, ESM (`"type": "module"`), **pnpm** workspaces, **vitest** for tests, `tsx` for scripts.
- Money: integer **micros** (6 decimals), `bigint` in SQL, **`string` in JSON and in TypeScript props**. Never use JS floats for money. `packs.price_micros` and `packs.escrow_price_micros` must be `>= 1000000` (1 tUSDM).
- Suggested defaults (spec §5.7): **100 calls for 2 tUSDM**, escrow 2 tUSDM per job. Masumi keeps **5%** of escrow payments; the dashboard says so.
- Ownership challenge: file at `httpChallengePath(apiId)` = `/.well-known/hirakumi/<apiId>.txt`. It is **single use** and **expires after 30 minutes**. The wallet message comes from `buildWalletChallenge({domain, sellerId, apiId, origin, payTo, network: "cardano:preprod", nonce, expires})`.
- Gateway internal routes need `Authorization: Bearer ${INTERNAL_TOKEN}`: `POST /internal/challenge/:apiId/check → {ok, triedUrl, detail}`, `POST /internal/apis/:apiId/reload`, `GET /internal/apis/:apiId/health → {health, checkedAt, lastReasons}`.
- Public buyer URLs: `${PUBLIC_BASE_URL}/a/:apiId`, `/a/:apiId/packs/:packId`, `/a/:apiId/x/:opId`, `/a/:apiId/availability`, `${PUBLIC_BASE_URL}/r/:ruleHash`.
- Health monitor: if `apis.health_checked_at` is older than **10 minutes**, show a stale warning (spec §11, Monitoring).
- Transaction links: `https://preprod.cardanoscan.io/transaction/<txHash>`.
- **Web write ownership** (contract): `sellers`, `challenges` (`kind='wallet'`; see contract addition A2 for `kind='http'`), the seller-confirmation columns of `operations` (`enabled`, `side_effects_confirmed_none`), `packs`, and these `apis.state` transitions only: `described → endpoints_confirmed`, `endpoints_confirmed → ownership_verified`, `rule_built → priced`, `priced → registering`, `live → retired`, plus `(new) → intake`. Every other table is read-only for web. The one exception is `scripts/dev-coworker.ts`, a local-only fixture that refuses non-localhost databases.
- **Copy rule:** user-facing text is plain English. Say "promise" (never "rule" or "acceptance rule"), "credits" for pack calls, and "Live / Down" for health. JSON is labelled "the exact check (JSON)".
- postgres.js transforms **column names only** (`transform: { column: { from: postgres.toCamel } }`). Never use `postgres.camel`: it also rewrites JSON keys, which would corrupt rule schemas such as `last_updated`.
- Tests always run against `TEST_DATABASE_URL` (default `postgres://hirakumi:hirakumi@localhost:5432/hirakumi_web_test`). The harness overwrites `DATABASE_URL` and refuses any database whose name lacks `test`/`e2e`, because tests truncate tables.

## Review Focus (5 failure modes most likely to bite users, each with its test added to the owning task)

| # | Failure mode | Why it bites | Test that guards it (owning task) |
|---|---|---|---|
| 1 | **Cross-seller access (IDOR):** seller B confirms endpoints, checks the file, prices or publishes seller A's API by guessing `apiId` | Every route takes `apiId` from the URL | `returns 404 for another seller's API` in Task 9 (endpoints), Task 11 (ownership) and Task 12 (pricing); `loadOwnedApi` always filters by `seller_id` |
| 2 | **Ownership bypass:** listing goes past Ownership with a signature from another wallet, a tampered or expired message, a reused challenge, or no served file (breaks US2) | The signature check is the only thing that ties payouts to the real owner | Task 5 `verifyCip30Signature` tests (tampered, wrong address, garbage). Task 11: `rejects a signature from a different wallet`, `refuses to reuse a consumed challenge`, `refuses an expired challenge`, `refuses to issue a wallet message before the file check passed` |
| 3 | **State skipping and double clicks:** Publish before pricing, re-confirming endpoints after ownership, two Publish clicks creating two registrations | The coworker acts on `state`; a skipped step means registering a listing without a promise or price | Task 12 `two concurrent publishes: exactly one succeeds`, `publish before pricing is refused`; Task 9 `refuses once ownership is verified`; Task 7 `the same link twice returns the same API` |
| 4 | **Money unit errors:** "2.5" stored as 2 or 2499999 micros, prices under 1 tUSDM reaching the DB check constraint as a 500, bigint leaking into JSON | Buyers get charged wrong amounts; seller sees a crash | Task 3 `parseTusdm` and `formatTusdm` tests; Task 12 `stores 2.5 tUSDM as 2500000 micros`, `refuses a pack under 1 tUSDM in plain English` |
| 5 | **Seller stuck with no explanation:** gateway unreachable, file check fails, coworker step fails, or the monitor stops and the dashboard still says Live | Spec requires a plain-language error state on every screen and "the exact URL tried and the error" | Task 10 gateway client errors to plain messages; Task 11 panel `shows the URL tried and the reason`; Task 3 `firstFailedStep` surfaces `output.error`; Task 7 `HealthBadge` `warns when the last check is older than 10 minutes` |

## Contract additions this plan needs (tell all owners)

- **A1 (superseded by contract v1.1 D2: use P3's `messages` table; don't create 0002_chat.sql). Migration `db/migrations/0002_chat.sql`** (owned by P2, created in Task 15) adds table `messages`. Web writes `author='seller'` rows. The coworker (P3) reads rows where `author='seller' and handled_at is null`, writes `author='coworker'` replies and sets `handled_at`.
- **A2. Web also writes `challenges(kind='http')`.** It creates the file token and records `proof = {passedAt, triedUrl}` after a successful check. The gateway only reads: it compares the fetched body, **trimmed of surrounding whitespace**, against the newest row `where api_id=$1 and kind='http' and consumed_at is null and expires_at > now()`. The gateway never writes `challenges`.
- **A3. `apis.escrow_op_id` stores the OpenAPI `operations.op_id`** (the same id as in `/a/:apiId/x/:opId`), not `operations.id`.
- **A4. On any `onboard_steps.status='failed'`, the coworker writes a plain-English `output.error` string.** Web shows it verbatim.
- **A5. New env vars:** `SESSION_SECRET` (web, ≥32 chars), `GATEWAY_INTERNAL_URL` (web, optional, defaults to `PUBLIC_BASE_URL`), `CHAT_FALLBACK=1` (web, shows the chat panel). **P4:** Caddy must route `/internal/*` to the gateway, because Vercel calls it over HTTPS with the bearer token. Postgres must accept connections from Vercel (TLS, strong password, `?sslmode=require` in the web `DATABASE_URL`).
- **A6. Login signature.** A signed session needs one extra wallet signature at sign-in. It is valid for 7 days. US1's "4 seller actions" does not count it. Say this in the demo or ask the spec owner to accept it.
- **A7. (Issue spotted, not ours to fix)** `rules.hash UNIQUE` collides when two operations, possibly in different APIs, infer identical definitions. P1/P3 should drop `UNIQUE` or make hashes distinct per operation. The web fixtures add `schema.title = "<apiId>/<opId>"` to avoid it.

## External APIs verified for this plan (evidence, 6 Oct 2026)

- `next@16.3.8`, `react@19.3.0` (npm `latest`). `params` and `searchParams` are Promises in pages and route handlers.
- `@meshsdk/core@1.9.1` re-exports `checkSignature` from `@meshsdk/core-cst@1.9.1` (`dist/index.d.ts` line 6). The plan depends on `@meshsdk/core-cst` directly. Signature: `checkSignature(data: string, { key, signature }: DataSignature, address?: string) => Promise<boolean>`. A hex `data` is compared to the COSE payload as is, and a non-hex string is hex-encoded first. **The plan always passes hex** (`utf8ToHex(message)`), which matches what the wallet signed.
- Round trip run in a scratch project: Mesh `signData(hex, {address, key})` → `checkSignature(hex, sig, bech32)`. Results: `true`; tampered message → `false`; other address → `false`; enterprise and base `addr_test1` addresses both `true`. `@cardano-foundation/cardano-verify-datasignature@1.0.11` `verifySignature(signature, key, message, address) => boolean` agreed (plain-text message). **libsodium needs initialising:** any `checkSignature` call awaits `ready()` first. Test fixtures that sign before verifying call `checkSignature` once to initialise.
- `deserializeAddress(hexOrBech32)` + `addressToBech32(address)` from `@meshsdk/core-cst` turn a CIP-30 hex address into bech32 (verified).
- CIP-30 (bundled reference `.claude/skills/connect-wallet/references/cip30-api-reference.md`): `api.signData(addr, payloadHex) → Promise<{ signature, key }>`. `addr` is the hex address from `getChangeAddress()`. Error codes: APIError Refused `-3`, AccountChange `-4`; DataSignError UserDeclined `3`, AddressNotPK `2`.
- `@x402/fetch@2.26.0` exports `wrapFetchWithPayment(fetch, client)` and `x402Client`. `x402Client.register(network, scheme)` and `.setSpendControls({ maxAmountPerPayment })` both return `x402Client`. **The default cap is "$1" and tUSDM preprod is a default asset**, so a 2 tUSDM pack needs `maxAmountPerPayment: "$2"`. The check is inclusive (`valueScaled <= capScaled`). `@x402/cardano@2.26.0` exports `toClientCardanoSigner({ mnemonic, network, provider: { blockfrost: { baseUrl, projectId? } } })`, and `@x402/cardano/exact/client` exports `ExactCardanoScheme`.
- `postgres@3.4.9`: `TransactionSql` does **not** extend `Sql`, so repository functions take `Sql` and open their own transactions with `sql.begin`. `postgres.toCamel` exists for column-only transforms.
- `shadcn@4.21.2` CLI: `init -y -d` (defaults = preset `base-nova`), `add -y <components>`, `--no-monorepo`.
- **Still unverified, with an explicit step in the plan:** a real Eternl `signData` through `checkSignature` (Task 6 Step 9 and Task 16), `next build` bundling `@meshsdk/core-cst` with `serverExternalPackages` (Task 1 Step 7, Task 6 Step 8), and the exact shadcn `base-nova` component file names (Task 1 Step 5).

---

## File Structure

```
db/migrations/0002_chat.sql                 # Task 15, contract addition A1
apps/web/
  package.json  tsconfig.json  next.config.ts  postcss.config.mjs  vercel.json
  vitest.config.ts  playwright.config.ts  components.json (shadcn)
  app/
    globals.css  layout.tsx  page.tsx  page.test.tsx
    login/page.tsx
    apis/page.tsx                            # list of the seller's APIs
    apis/new/page.tsx                        # Setup screen
    apis/[apiId]/layout.tsx                  # nav + chat panel
    apis/[apiId]/page.tsx                    # redirects to the current step
    apis/[apiId]/endpoints/page.tsx          # Endpoints screen
    apis/[apiId]/ownership/page.tsx          # Ownership screen
    apis/[apiId]/review/page.tsx             # Review screen
    apis/[apiId]/overview/page.tsx           # API overview screen
    apis/[apiId]/sales/page.tsx              # Sales screen
    p/[apiId]/page.tsx                       # public API page with buyer snippet
    api/auth/nonce/route.ts  api/auth/verify/route.ts  api/auth/logout/route.ts  api/auth/auth.test.ts
    api/apis/route.ts  api/apis/apis.test.ts
    api/apis/[apiId]/endpoints/route.ts  api/apis/[apiId]/endpoints/endpoints.test.ts
    api/apis/[apiId]/challenge-file/route.ts
    api/apis/[apiId]/ownership/http-check/route.ts
    api/apis/[apiId]/ownership/wallet-challenge/route.ts
    api/apis/[apiId]/ownership/verify/route.ts
    api/apis/[apiId]/ownership/ownership.test.ts
    api/apis/[apiId]/pricing/route.ts  api/apis/[apiId]/publish/route.ts  api/apis/[apiId]/review.test.ts
    api/apis/[apiId]/retire/route.ts  api/apis/[apiId]/retire/retire.test.ts
    api/chat/route.ts  api/chat/chat.test.ts
  components/
    ui/button.tsx ui/input.tsx ui/badge.tsx  # generated by shadcn
    states.tsx  auto-refresh.tsx  step-list.tsx  health-badge.tsx  api-nav.tsx
    wallet-login.tsx  setup-form.tsx  endpoints-form.tsx  ownership-panel.tsx  review-panel.tsx
    buyer-snippet.tsx  retire-button.tsx  sales-tables.tsx  chat-panel.tsx
    *.test.tsx                               # one per interactive component
  lib/
    env.ts  db.ts  types.ts  money.ts  copy.ts  flow.ts  endpoints.ts  validate.ts
    session.ts  http.ts  route-helpers.ts  page-auth.ts  cardano.ts  gateway.ts
    wallet-client.ts  client-fetch.ts  snippet.ts
    repo/sellers.ts  repo/apis.ts  repo/operations.ts  repo/challenges.ts
    repo/rules.ts  repo/packs.ts  repo/stats.ts  repo/chat.ts
    *.test.ts  repo/*.test.ts
  scripts/dev-coworker.ts  scripts/dev-coworker.test.ts  scripts/mock-gateway.ts
  test/env.ts  test/global-setup.ts  test/setup.ts  test/db.ts  test/factories.ts
  test/requests.ts  test/http.ts  test/wallet-fixture.ts  test/db.test.ts
  e2e/env.ts  e2e/global-setup.ts  e2e/happy-path.spec.ts   # Task 17, optional
```

Responsibilities: `lib/repo/*` is the only place with SQL. `app/api/**/route.ts` handles authentication, input checks and status codes, then calls a repo function. `components/*` are client components that call routes through `lib/client-fetch.ts`. Pages are thin server components: load data, choose the empty, waiting, error or ready state, and render one component.

---
## Tasks

Run every command from the repository root unless a step says otherwise. Paths with `[apiId]` must be quoted in shells.

**Prerequisites (hour 0–2):** P1 has created the pnpm workspace root, `db/migrations/0001_init.sql` and a `packages/core` that exports the contract API (`newId`, `ruleHash`, `RuleDefinition`, `buildWalletChallenge`, `httpChallengePath`). For a local Postgres, use `docker compose up -d postgres` (P4). If the compose file isn't ready yet, run `docker run -d --name hirakumi-pg -e POSTGRES_USER=hirakumi -e POSTGRES_PASSWORD=hirakumi -e POSTGRES_DB=hirakumi -p 5432:5432 postgres:17`.

### Task 1: Scaffold `apps/web` (Next.js 16, Tailwind 4, shadcn, vitest)

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/vercel.json`, `apps/web/vitest.config.ts`, `apps/web/test/setup.ts`, `apps/web/app/globals.css`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/page.test.tsx`
- Generated by shadcn: `apps/web/components.json`, `apps/web/lib/utils.ts`, `apps/web/components/ui/button.tsx`, `apps/web/components/ui/input.tsx`, `apps/web/components/ui/badge.tsx`

**Interfaces:**
- Consumes: workspace root `pnpm-workspace.yaml` (contract), `@hirakumi/core` (workspace).
- Produces: `default export Home(): JSX.Element` (`app/page.tsx`); `Button`, `Input`, `Badge` from `@/components/ui/*`; `cn(...classes)` from `@/lib/utils`; path alias `@/*` → `apps/web/*`.

- [ ] **Step 1: Write the package and config files**

`apps/web/package.json`:
```json
{
  "name": "@hirakumi/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev --port 3000",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dev:coworker": "tsx scripts/dev-coworker.ts",
    "dev:gateway": "tsx scripts/mock-gateway.ts",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@hirakumi/core": "workspace:*",
    "@meshsdk/core-cst": "1.9.1",
    "next": "16.3.8",
    "postgres": "3.4.9",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@tailwindcss/postcss": "4.3.3",
    "@testing-library/dom": "10.4.2",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.7",
    "@types/node": "^22.0.0",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.2",
    "jsdom": "30.1.2",
    "tailwindcss": "4.3.3",
    "tsx": "4.23.15",
    "typescript": "5.9.3",
    "vite": "8.3.3",
    "vitest": "5.0.3"
  }
}
```

`apps/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next"]
}
```

`apps/web/next.config.ts`:
```ts
import type { NextConfig } from "next";

const config: NextConfig = {
  // Mesh pulls in libsodium (WASM); keep it out of the server bundle and load it from node_modules.
  serverExternalPackages: ["@meshsdk/core-cst"],
  // @hirakumi/core may ship TypeScript source from the workspace.
  transpilePackages: ["@hirakumi/core"],
};

export default config;
```

`apps/web/postcss.config.mjs`:
```js
export default { plugins: { "@tailwindcss/postcss": {} } };
```

`apps/web/vercel.json` (Singapore, next to the EC2 Postgres in ap-southeast-1):
```json
{ "regions": ["sin1"] }
```

`apps/web/vitest.config.ts`:
```ts
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^@\//, replacement: root }] },
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
```

`apps/web/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
```

`apps/web/app/globals.css`:
```css
@import "tailwindcss";
```

`apps/web/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hirakumi",
  description: "Put your API on the agent market. Buyers only pay for responses that keep your promise.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <header className="border-b">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link href="/apis" className="font-semibold">
              Hirakumi
            </Link>
            <span className="text-sm text-muted-foreground">Cardano preprod test network</span>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Write the failing smoke test**

`apps/web/app/page.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("Home", () => {
  it("invites the seller to list an API", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "Put your API on the agent market" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/login");
  });
});
```

- [ ] **Step 3: Install and run the test (expect FAIL)**

Run: `pnpm install && pnpm --filter @hirakumi/web exec vitest run app/page.test.tsx`
Expected: FAIL, `Failed to resolve import "./page"`.

- [ ] **Step 4: Write the home page**

`apps/web/app/page.tsx`:
```tsx
export default function Home() {
  return (
    <section className="max-w-2xl space-y-4">
      <h1 className="text-3xl font-semibold">Put your API on the agent market</h1>
      <p className="text-muted-foreground">
        Hand over a link to your OpenAPI description, prove you own the API, then approve a price and a promise.
        AI agents buy credits from you directly, and they only spend a credit when your response keeps the promise.
      </p>
      <a href="/login" className="inline-block rounded-md bg-primary px-4 py-2 text-primary-foreground">
        Get started
      </a>
    </section>
  );
}
```

- [ ] **Step 5: Add shadcn/ui (Button, Input, Badge)**

Run:
```bash
cd apps/web && pnpm dlx shadcn@4.21.2 init -y -d --no-monorepo && pnpm dlx shadcn@4.21.2 add -y button input badge && ls components/ui lib/utils.ts
```
Expected: `badge.tsx  button.tsx  input.tsx` and `lib/utils.ts` are listed, and `app/globals.css` now holds theme variables after `@import "tailwindcss";`. If the preset names a file differently, rename it to these three names. The plan imports `Button` from `@/components/ui/button`, `Input` from `@/components/ui/input` and `Badge` from `@/components/ui/badge`, and uses only `variant` ∈ {`default`,`secondary`,`destructive`,`outline`} on `Badge` and `Button`, plus `disabled`, `onClick` and `type`.

- [ ] **Step 6: Run the test (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run app/page.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 7: Build once to prove the toolchain**

Run: `pnpm --filter @hirakumi/web build`
Expected: `✓ Compiled successfully` and route `/` listed. Next may rewrite `tsconfig.json` (it adds `next-env.d.ts`); keep its edits.

- [ ] **Step 8: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): scaffold Next.js 16 dashboard with Tailwind, shadcn and vitest" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Database client and test harness

**Files:**
- Create: `apps/web/lib/env.ts`, `apps/web/lib/db.ts`, `apps/web/lib/types.ts`, `apps/web/test/env.ts`, `apps/web/test/global-setup.ts`, `apps/web/test/db.ts`, `apps/web/test/factories.ts`, `apps/web/test/db.test.ts`
- Modify: `apps/web/vitest.config.ts`, `apps/web/test/setup.ts`

**Interfaces:**
- Consumes: `db/migrations/*.sql` (contract `0001_init.sql`); `newId(prefix)`, `ruleHash(def)`, `RuleDefinition` from `@hirakumi/core`.
- Produces:
  - `env.databaseUrl(): string`, `env.sessionSecret(): string`, `env.internalToken(): string`, `env.gatewayInternalUrl(): string`, `env.publicBaseUrl(): string`, `env.webBaseUrl(): string`, `env.allowInsecureUpstream(): boolean`, `env.chatFallback(): boolean`, `env.secureCookies(): boolean`
  - `type Sql = postgres.Sql`; `getSql(): Sql`; `closeSql(): Promise<void>`
  - Types `ApiState`, `API_STATES`, `Health`, `Seller`, `Api`, `Operation`, `OnboardStep`, `RuleView`, `Pack`, `RepoResult`
  - Test helpers: `resetDatabase(url)`, `resetDb()`, `seedSeller(addr?)`, `seedApi(sellerId, state?, over?)`, `seedOperation(apiId, over?)`, `seedRule(operationId, over?)`, `seedPack(apiId, over?)`, `seedOnboardStep(apiId, step, status, output?)`, `TEST_RULE`

- [ ] **Step 1: Write env, db and types**

`apps/web/lib/env.ts`:
```ts
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const env = {
  databaseUrl: () => required("DATABASE_URL"),
  sessionSecret: () => {
    const secret = required("SESSION_SECRET");
    if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    return secret;
  },
  internalToken: () => required("INTERNAL_TOKEN"),
  gatewayInternalUrl: () => process.env.GATEWAY_INTERNAL_URL || required("PUBLIC_BASE_URL"),
  publicBaseUrl: () => required("PUBLIC_BASE_URL").replace(/\/+$/, ""),
  webBaseUrl: () => required("WEB_BASE_URL").replace(/\/+$/, ""),
  allowInsecureUpstream: () => process.env.ALLOW_INSECURE_UPSTREAM === "1",
  chatFallback: () => process.env.CHAT_FALLBACK === "1",
  secureCookies: () => process.env.NODE_ENV === "production",
};
```

`apps/web/lib/db.ts`:
```ts
import postgres from "postgres";
import { env } from "./env";

export type Sql = postgres.Sql;

const globalForSql = globalThis as unknown as { __hirakumiSql?: Sql };

export function getSql(): Sql {
  if (!globalForSql.__hirakumiSql) {
    globalForSql.__hirakumiSql = postgres(env.databaseUrl(), {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      // Column names only. JSON values (rule schemas) must keep the seller's own keys such as last_updated.
      transform: { column: { from: postgres.toCamel } },
      onnotice: () => {},
    });
  }
  return globalForSql.__hirakumiSql;
}

export async function closeSql(): Promise<void> {
  const sql = globalForSql.__hirakumiSql;
  globalForSql.__hirakumiSql = undefined;
  if (sql) await sql.end({ timeout: 5 });
}
```

`apps/web/lib/types.ts`:
```ts
export const API_STATES = [
  "intake",
  "parsed",
  "described",
  "endpoints_confirmed",
  "ownership_verified",
  "rule_built",
  "priced",
  "registering",
  "live",
  "retired",
] as const;
export type ApiState = (typeof API_STATES)[number];
export type Health = "healthy" | "down";

export type Seller = { id: string; cardanoAddr: string };

export type Api = {
  id: string;
  sellerId: string;
  name: string;
  origin: string;
  openapiUrl: string;
  state: ApiState;
  health: Health;
  healthCheckedAt: Date | null;
  escrowOpId: string | null;
  agentIdentifier: string | null;
  createdAt: Date;
};

export type Operation = {
  id: string;
  opId: string;
  method: string;
  path: string;
  description: string | null;
  sideEffectsLikely: boolean;
  sideEffectsConfirmedNone: boolean;
  enabled: boolean;
};

export type OnboardStepStatus = "pending" | "running" | "done" | "failed" | "waiting_seller";
export type OnboardStep = { step: string; status: OnboardStepStatus; output: unknown; updatedAt: Date };

export type RuleView = {
  operationId: string;
  opId: string;
  method: string;
  path: string;
  version: number;
  hash: string;
  definition: unknown;
  plainEnglish: string | null;
};

export type Pack = { id: string; calls: number; priceMicros: string; escrowPriceMicros: string };

export type RepoResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };
```

- [ ] **Step 2: Write the harness and factories**

`apps/web/test/env.ts`:
```ts
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi_web_test";

export const TEST_ENV: Record<string, string> = {
  DATABASE_URL: TEST_DATABASE_URL, // always the test database: tests truncate tables
  SESSION_SECRET: "test-session-secret-0123456789abcdef",
  INTERNAL_TOKEN: "test-internal-token",
  PUBLIC_BASE_URL: "https://api.hirakumi.test",
  GATEWAY_INTERNAL_URL: "https://gateway.hirakumi.test",
  WEB_BASE_URL: "https://web.hirakumi.test",
  ALLOW_INSECURE_UPSTREAM: "0",
  CHAT_FALLBACK: "1",
};
```

`apps/web/test/global-setup.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "./env";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

export async function resetDatabase(url: string): Promise<void> {
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/test|e2e/.test(dbName)) {
    throw new Error(`Refusing to reset "${dbName}": the database name must contain "test" or "e2e".`);
  }
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const found = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (found.length === 0) await admin.unsafe(`create database "${dbName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe("drop schema if exists public cascade; create schema public;");
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  } finally {
    await sql.end();
  }
}

export default async function globalSetup(): Promise<void> {
  await resetDatabase(TEST_DATABASE_URL);
}
```

`apps/web/test/db.ts`:
```ts
import { getSql } from "@/lib/db";

// Every table hangs off sellers through foreign keys, so one cascade empties them all (messages included).
export async function resetDb(): Promise<void> {
  await getSql()`truncate sellers restart identity cascade`;
}
```

`apps/web/test/factories.ts`:
```ts
import { randomBytes } from "node:crypto";
import { newId, ruleHash, type RuleDefinition } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import type { Api, ApiState, Health, OnboardStepStatus, Operation, Pack, Seller } from "@/lib/types";

const API_COLUMNS = [
  "id", "seller_id", "name", "origin", "openapi_url", "state", "health",
  "health_checked_at", "escrow_op_id", "agent_identifier", "created_at",
];

export const TEST_RULE: RuleDefinition = {
  version: 1,
  status: { min: 200, max: 299 },
  contentType: "application/json",
  schema: {
    type: "object",
    required: ["price", "last_updated"],
    properties: { price: { type: "number" }, last_updated: { type: "string", maxAgeSeconds: 300 } },
  },
};

export async function seedSeller(cardanoAddr = `addr_test1seed${randomBytes(8).toString("hex")}`): Promise<Seller> {
  const sql = getSql();
  const [row] = await sql<Seller[]>`
    insert into sellers (id, cardano_addr) values (${newId("sel")}, ${cardanoAddr})
    returning id, cardano_addr`;
  return row;
}

export async function seedApi(
  sellerId: string,
  state: ApiState = "intake",
  over: Partial<{ name: string; origin: string; openapiUrl: string; escrowOpId: string | null;
    agentIdentifier: string | null; health: Health; healthCheckedAt: Date | null }> = {},
): Promise<Api> {
  const sql = getSql();
  const [row] = await sql<Api[]>`
    insert into apis (id, seller_id, name, origin, openapi_url, state, health, health_checked_at, escrow_op_id, agent_identifier)
    values (${newId("api")}, ${sellerId}, ${over.name ?? "Price API"}, ${over.origin ?? "https://price.example.dev"},
            ${over.openapiUrl ?? "https://price.example.dev/openapi.json"}, ${state}, ${over.health ?? "healthy"},
            ${over.healthCheckedAt ?? null}, ${over.escrowOpId ?? null}, ${over.agentIdentifier ?? null})
    returning ${sql(API_COLUMNS)}`;
  return row;
}

export async function seedOperation(
  apiId: string,
  over: Partial<Omit<Operation, "id">> = {},
): Promise<Operation> {
  const sql = getSql();
  const [row] = await sql<Operation[]>`
    insert into operations (id, api_id, op_id, method, path, input_schema, description, side_effects_likely,
                            side_effects_confirmed_none, enabled)
    values (${newId("op")}, ${apiId}, ${over.opId ?? "getPrice"}, ${over.method ?? "GET"}, ${over.path ?? "/price"},
            '{}'::jsonb, ${over.description ?? "Latest price for a symbol"}, ${over.sideEffectsLikely ?? false},
            ${over.sideEffectsConfirmedNone ?? false}, ${over.enabled ?? false})
    returning id, op_id, method, path, description, side_effects_likely, side_effects_confirmed_none, enabled`;
  return row;
}

export async function seedRule(
  operationId: string,
  over: Partial<{ definition: RuleDefinition; plainEnglish: string | null; version: number }> = {},
): Promise<{ id: string; hash: string }> {
  const sql = getSql();
  const definition: RuleDefinition = over.definition ?? {
    ...TEST_RULE,
    schema: { ...TEST_RULE.schema, title: operationId }, // distinct hash per operation (contract note A7)
  };
  const [row] = await sql<{ id: string; hash: string }[]>`
    insert into rules (id, operation_id, version, definition, hash, plain_english)
    values (${newId("rule")}, ${operationId}, ${over.version ?? 1}, ${JSON.stringify(definition)}::jsonb,
            ${ruleHash(definition)},
            ${over.plainEnglish === undefined ? 'The response has a number "price" and a "last_updated" time under 5 minutes old.' : over.plainEnglish})
    returning id, hash`;
  return row;
}

export async function seedPack(
  apiId: string,
  over: Partial<{ calls: number; priceMicros: string; escrowPriceMicros: string }> = {},
): Promise<Pack> {
  const sql = getSql();
  const [row] = await sql<Pack[]>`
    insert into packs (id, api_id, calls, price_micros, escrow_price_micros)
    values (${newId("pk")}, ${apiId}, ${over.calls ?? 100}, ${over.priceMicros ?? "2000000"}::bigint,
            ${over.escrowPriceMicros ?? "2000000"}::bigint)
    returning id, calls, price_micros::text as price_micros, escrow_price_micros::text as escrow_price_micros`;
  return row;
}

export async function seedOnboardStep(
  apiId: string,
  step: string,
  status: OnboardStepStatus,
  output: unknown = null,
): Promise<void> {
  await getSql()`
    insert into onboard_steps (api_id, step, status, attempts, output)
    values (${apiId}, ${step}, ${status}, 1, ${JSON.stringify(output)}::jsonb)`;
}
```

Replace `apps/web/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach } from "vitest";
import { closeSql } from "@/lib/db";
import { TEST_ENV } from "./env";

Object.assign(process.env, TEST_ENV);

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await closeSql();
});
```

In `apps/web/vitest.config.ts`, add `globalSetup` to the `test` block:
```ts
    setupFiles: ["./test/setup.ts"],
    globalSetup: ["./test/global-setup.ts"],
```

- [ ] **Step 3: Write the failing harness test**

`apps/web/test/db.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "./db";
import { seedApi, seedOperation, seedRule, seedSeller } from "./factories";

describe("test database harness", () => {
  beforeEach(resetDb);

  it("has the contract schema applied", async () => {
    const rows = await getSql()<{ tableName: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
    const names = rows.map((r) => r.tableName);
    for (const t of ["apis", "calls", "challenges", "credit_tokens", "health_events", "jobs", "operations", "packs", "rules", "sellers"]) {
      expect(names).toContain(t);
    }
  });

  it("returns camelCase columns but keeps JSON keys exactly as stored", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "rule_built");
    const op = await seedOperation(api.id);
    await seedRule(op.id);
    const [row] = await getSql()<{ operationId: string; definition: { schema: { properties: object } } }[]>`
      select operation_id, definition from rules where operation_id = ${op.id}`;
    expect(row.operationId).toBe(op.id);
    expect(row.definition.schema.properties).toHaveProperty("last_updated");
    expect(row.definition.schema.properties).not.toHaveProperty("lastUpdated");
  });

  it("empties every table between tests", async () => {
    const [{ count }] = await getSql()<{ count: number }[]>`select count(*)::int as count from apis`;
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 4: Run the test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run test/db.test.ts`
Expected: FAIL, `Failed to resolve import "@/lib/db"` (if run before Step 1), or a connection error if Postgres is not running. Start Postgres per the prerequisites and run again.

- [ ] **Step 5: Run the test (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run test/db.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): postgres client, shared types and an isolated test database harness" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Pure helpers — money, copy, flow, endpoint selection

**Files:**
- Create: `apps/web/lib/money.ts`, `apps/web/lib/copy.ts`, `apps/web/lib/flow.ts`, `apps/web/lib/endpoints.ts`
- Test: `apps/web/lib/money.test.ts`, `apps/web/lib/copy.test.ts`, `apps/web/lib/flow.test.ts`, `apps/web/lib/endpoints.test.ts`

**Interfaces:**
- Consumes: `ApiState`, `Health`, `OnboardStep`, `OnboardStepStatus` (Task 2).
- Produces:
  - `MIN_PRICE_MICROS = 1_000_000n`; `class MoneyError`; `parseTusdm(input: string): bigint`; `formatTusdm(micros: string | bigint): string`; `parsePackCalls(input: string): number`; `perCallTusdm(priceMicros: string | bigint, calls: number): string`
  - `STATE_LABEL: Record<ApiState, string>`; `healthLabel(h: Health): "Live" | "Down"`; `STEP_STATUS_LABEL`; `PACK_STATUS_LABEL`; `JOB_STATUS_LABEL`; `cardanoscanTxUrl(txHash)`; `shortAddress(addr)`; `humanizeStep(step)`; `formatTime(d)`
  - `type Step = "endpoints" | "ownership" | "review" | "overview"`; `stepForState(s: ApiState): Step`; `safeNextPath(raw): string`; `STALE_AFTER_MS`; `isStale(checkedAt: Date | null, now?: Date): boolean`; `firstFailedStep(steps): string | null`
  - `type EndpointSelection = { enabledIds: string[]; confirmedNoSideEffectIds: string[]; escrowOperationId: string | null }`; `needsNoSideEffectConfirmation(op)`; `validateEndpointSelection(ops, selection): string | null`; `parseSelection(body): EndpointSelection | null`

- [ ] **Step 1: Write the failing tests**

`apps/web/lib/money.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatTusdm, MoneyError, parsePackCalls, parseTusdm, perCallTusdm } from "./money";

describe("parseTusdm", () => {
  it.each([
    ["2", 2_000_000n],
    ["2.5", 2_500_000n],
    ["0.000001", 1n],
    [" 3 ", 3_000_000n],
    ["2.10", 2_100_000n],
  ])("parses %j to %s micros without floating point", (input, micros) => {
    expect(parseTusdm(input)).toBe(micros);
  });

  it.each(["", "abc", "-1", "1e6", "2,5", "2.0000001", ".5", "1234567890"])("rejects %j in plain English", (input) => {
    expect(() => parseTusdm(input)).toThrow(MoneyError);
    expect(() => parseTusdm(input)).toThrow(/Enter an amount like 2 or 2.50/);
  });
});

describe("formatTusdm", () => {
  it("formats micros as a short decimal", () => {
    expect(formatTusdm("2500000")).toBe("2.5");
    expect(formatTusdm(2_000_000n)).toBe("2");
    expect(formatTusdm("1")).toBe("0.000001");
  });
});

describe("parsePackCalls", () => {
  it("accepts whole numbers from 1 to 100000", () => {
    expect(parsePackCalls("100")).toBe(100);
    expect(parsePackCalls("1")).toBe(1);
  });
  it.each(["0", "1.5", "100001", "abc", ""])("rejects %j", (input) => {
    expect(() => parsePackCalls(input)).toThrow(MoneyError);
  });
});

describe("perCallTusdm", () => {
  it("divides the pack price across its calls", () => {
    expect(perCallTusdm("2000000", 100)).toBe("0.02");
  });
});
```

`apps/web/lib/copy.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { API_STATES } from "./types";
import {
  cardanoscanTxUrl, healthLabel, humanizeStep, JOB_STATUS_LABEL, PACK_STATUS_LABEL, shortAddress,
  STATE_LABEL, STEP_STATUS_LABEL,
} from "./copy";

describe("copy", () => {
  it("has a plain-English label for every API state", () => {
    for (const s of API_STATES) expect(STATE_LABEL[s]).toMatch(/\S/);
  });

  it("never uses jargon the copy rule forbids", () => {
    const all = [
      ...Object.values(STATE_LABEL), ...Object.values(STEP_STATUS_LABEL),
      ...Object.values(PACK_STATUS_LABEL), ...Object.values(JOB_STATUS_LABEL),
    ];
    for (const text of all) expect(text).not.toMatch(/\b(rule|acceptance|x402|lovelace|micros)\b/i);
  });

  it("says Live or Down for health", () => {
    expect(healthLabel("healthy")).toBe("Live");
    expect(healthLabel("down")).toBe("Down");
  });

  it("links transactions to preprod Cardanoscan", () => {
    expect(cardanoscanTxUrl("abc123")).toBe("https://preprod.cardanoscan.io/transaction/abc123");
  });

  it("shortens long addresses and humanizes step names", () => {
    expect(shortAddress("addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzz")).toBe("addr_test1qq…zzzzzz");
    expect(humanizeStep("qa_tests")).toBe("Qa tests");
  });
});
```

`apps/web/lib/flow.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { firstFailedStep, isStale, safeNextPath, stepForState } from "./flow";

describe("stepForState", () => {
  it("sends each state to the screen that can move it forward", () => {
    expect(stepForState("intake")).toBe("endpoints");
    expect(stepForState("described")).toBe("endpoints");
    expect(stepForState("endpoints_confirmed")).toBe("ownership");
    expect(stepForState("ownership_verified")).toBe("review");
    expect(stepForState("priced")).toBe("review");
    expect(stepForState("registering")).toBe("overview");
    expect(stepForState("live")).toBe("overview");
    expect(stepForState("retired")).toBe("overview");
  });
});

describe("safeNextPath", () => {
  it("only allows same-site paths", () => {
    expect(safeNextPath("/apis/api_1")).toBe("/apis/api_1");
    expect(safeNextPath("https://evil.example")).toBe("/apis");
    expect(safeNextPath("//evil.example")).toBe("/apis");
    expect(safeNextPath("/\\evil.example")).toBe("/apis");
    expect(safeNextPath(undefined)).toBe("/apis");
  });
});

describe("isStale", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  it("is stale when never checked or older than 10 minutes", () => {
    expect(isStale(null, now)).toBe(true);
    expect(isStale(new Date("2026-10-06T11:49:00Z"), now)).toBe(true);
    expect(isStale(new Date("2026-10-06T11:55:00Z"), now)).toBe(false);
  });
});

describe("firstFailedStep", () => {
  it("returns the coworker's plain-English error for a failed step", () => {
    expect(
      firstFailedStep([
        { status: "done", output: null },
        { status: "failed", output: { error: "This looks like Swagger 2.0. Hirakumi needs OpenAPI 3.x." } },
      ]),
    ).toBe("This looks like Swagger 2.0. Hirakumi needs OpenAPI 3.x.");
  });
  it("falls back to a generic sentence when the step has no message", () => {
    expect(firstFailedStep([{ status: "failed", output: null }])).toMatch(/Something went wrong while preparing your listing/);
  });
  it("returns null when nothing failed", () => {
    expect(firstFailedStep([{ status: "running", output: null }])).toBeNull();
  });
});
```

`apps/web/lib/endpoints.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { needsNoSideEffectConfirmation, parseSelection, validateEndpointSelection } from "./endpoints";

const ops = [
  { id: "op_get", method: "GET", path: "/price", sideEffectsLikely: false },
  { id: "op_post", method: "POST", path: "/admin/refresh", sideEffectsLikely: true },
  { id: "op_risky_get", method: "GET", path: "/reset", sideEffectsLikely: true },
];

describe("endpoint selection", () => {
  it("needs a no-side-effects tick for non-GET or flagged operations", () => {
    expect(needsNoSideEffectConfirmation(ops[0])).toBe(false);
    expect(needsNoSideEffectConfirmation(ops[1])).toBe(true);
    expect(needsNoSideEffectConfirmation(ops[2])).toBe(true);
  });

  it("accepts a GET with an escrow choice", () => {
    expect(validateEndpointSelection(ops, { enabledIds: ["op_get"], confirmedNoSideEffectIds: [], escrowOperationId: "op_get" })).toBeNull();
  });

  it("requires at least one endpoint", () => {
    expect(validateEndpointSelection(ops, { enabledIds: [], confirmedNoSideEffectIds: [], escrowOperationId: null }))
      .toBe("Choose at least one endpoint to sell.");
  });

  it("requires the tick for a POST endpoint", () => {
    expect(validateEndpointSelection(ops, { enabledIds: ["op_post"], confirmedNoSideEffectIds: [], escrowOperationId: "op_post" }))
      .toBe("Confirm that POST /admin/refresh changes nothing on your server, or don't sell it.");
  });

  it("requires the escrow endpoint to be one of the sold endpoints", () => {
    expect(validateEndpointSelection(ops, { enabledIds: ["op_get"], confirmedNoSideEffectIds: [], escrowOperationId: null }))
      .toBe("Choose which endpoint runs for per-job hires.");
    expect(validateEndpointSelection(ops, { enabledIds: ["op_get"], confirmedNoSideEffectIds: ["op_post"], escrowOperationId: "op_post" }))
      .toBe("The per-job endpoint must be one of the endpoints you sell.");
  });

  it("rejects unknown operation ids", () => {
    expect(validateEndpointSelection(ops, { enabledIds: ["op_gone"], confirmedNoSideEffectIds: [], escrowOperationId: "op_gone" }))
      .toBe("One of the chosen endpoints no longer exists. Reload the page.");
  });

  it("parses a request body defensively", () => {
    expect(parseSelection({ enabledIds: ["a"], confirmedNoSideEffectIds: [], escrowOperationId: "a" }))
      .toEqual({ enabledIds: ["a"], confirmedNoSideEffectIds: [], escrowOperationId: "a" });
    expect(parseSelection({ enabledIds: "a" })).toBeNull();
    expect(parseSelection({ enabledIds: [1], confirmedNoSideEffectIds: [], escrowOperationId: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/money.test.ts lib/copy.test.ts lib/flow.test.ts lib/endpoints.test.ts`
Expected: FAIL, `Failed to resolve import "./money"` (and the same for `./copy`, `./flow`, `./endpoints`).

- [ ] **Step 3: Write the implementations**

`apps/web/lib/money.ts`:
```ts
export const MIN_PRICE_MICROS = 1_000_000n;
const MICROS = 1_000_000n;

export class MoneyError extends Error {}

/** "2.5" -> 2500000n. String arithmetic only: never parse money as a float. */
export function parseTusdm(input: string): bigint {
  const s = input.trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(s)) {
    throw new MoneyError("Enter an amount like 2 or 2.50 (up to 6 decimal places).");
  }
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * MICROS + BigInt(frac.padEnd(6, "0"));
}

export function formatTusdm(micros: string | bigint): string {
  const value = BigInt(micros);
  const whole = value / MICROS;
  const frac = (value % MICROS).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function parsePackCalls(input: string): number {
  const s = input.trim();
  if (!/^\d{1,6}$/.test(s)) throw new MoneyError("Pack size must be a whole number of calls.");
  const n = Number(s);
  if (n < 1 || n > 100_000) throw new MoneyError("Pack size must be between 1 and 100,000 calls.");
  return n;
}

export function perCallTusdm(priceMicros: string | bigint, calls: number): string {
  return formatTusdm(BigInt(priceMicros) / BigInt(calls));
}
```

`apps/web/lib/copy.ts`:
```ts
import type { ApiState, Health, OnboardStepStatus } from "./types";

export const STATE_LABEL: Record<ApiState, string> = {
  intake: "Reading your API description",
  parsed: "Describing your endpoints",
  described: "Waiting for you to choose endpoints",
  endpoints_confirmed: "Waiting for you to prove ownership",
  ownership_verified: "Running test calls",
  rule_built: "Waiting for you to set a price",
  priced: "Ready to publish",
  registering: "Registering on the Masumi network",
  live: "Live",
  retired: "Removed from the market",
};

export function healthLabel(h: Health): "Live" | "Down" {
  return h === "healthy" ? "Live" : "Down";
}

export const STEP_STATUS_LABEL: Record<OnboardStepStatus, string> = {
  pending: "Waiting",
  running: "In progress",
  done: "Done",
  failed: "Failed",
  waiting_seller: "Waiting for you",
};

export const PACK_STATUS_LABEL = {
  pending: "Waiting for the payment to settle",
  active: "Paid, credits available",
  exhausted: "Paid, all credits used",
  revoked: "Paid, access revoked",
} as const;

export const JOB_STATUS_LABEL = {
  awaiting_payment: "Waiting for the buyer's payment",
  running: "Running",
  completed: "Passed, result submitted",
  failed: "Didn't pass, Masumi refunds the buyer automatically",
  expired: "Expired, the buyer never paid",
} as const;

export function cardanoscanTxUrl(txHash: string): string {
  return `https://preprod.cardanoscan.io/transaction/${encodeURIComponent(txHash)}`;
}

export function shortAddress(addr: string): string {
  return addr.length <= 20 ? addr : `${addr.slice(0, 12)}…${addr.slice(-6)}`;
}

export function humanizeStep(step: string): string {
  const words = step.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatTime(d: Date | string): string {
  return new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Singapore", dateStyle: "medium", timeStyle: "short" });
}
```

`apps/web/lib/flow.ts`:
```ts
import type { ApiState, OnboardStep } from "./types";

export type Step = "endpoints" | "ownership" | "review" | "overview";

export function stepForState(state: ApiState): Step {
  switch (state) {
    case "intake":
    case "parsed":
    case "described":
      return "endpoints";
    case "endpoints_confirmed":
      return "ownership";
    case "ownership_verified":
    case "rule_built":
    case "priced":
      return "review";
    default:
      return "overview";
  }
}

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/apis";
  return raw;
}

export const STALE_AFTER_MS = 10 * 60 * 1000;

export function isStale(checkedAt: Date | null, now: Date = new Date()): boolean {
  return !checkedAt || now.getTime() - checkedAt.getTime() > STALE_AFTER_MS;
}

export function firstFailedStep(steps: Pick<OnboardStep, "status" | "output">[]): string | null {
  const failed = steps.find((s) => s.status === "failed");
  if (!failed) return null;
  const output = failed.output as { error?: unknown } | null;
  if (output && typeof output.error === "string" && output.error.trim()) return output.error;
  return "Something went wrong while preparing your listing. Try pasting the link again.";
}
```

`apps/web/lib/endpoints.ts`:
```ts
export type EndpointSelection = {
  enabledIds: string[];
  confirmedNoSideEffectIds: string[];
  escrowOperationId: string | null;
};

type OpLike = { id: string; method: string; path: string; sideEffectsLikely: boolean };

export function needsNoSideEffectConfirmation(op: Pick<OpLike, "method" | "sideEffectsLikely">): boolean {
  return op.method.toUpperCase() !== "GET" || op.sideEffectsLikely;
}

export function validateEndpointSelection(ops: OpLike[], s: EndpointSelection): string | null {
  if (s.enabledIds.length === 0) return "Choose at least one endpoint to sell.";
  const byId = new Map(ops.map((o) => [o.id, o]));
  for (const id of s.enabledIds) {
    const op = byId.get(id);
    if (!op) return "One of the chosen endpoints no longer exists. Reload the page.";
    if (needsNoSideEffectConfirmation(op) && !s.confirmedNoSideEffectIds.includes(id)) {
      return `Confirm that ${op.method.toUpperCase()} ${op.path} changes nothing on your server, or don't sell it.`;
    }
  }
  if (!s.escrowOperationId) return "Choose which endpoint runs for per-job hires.";
  if (!s.enabledIds.includes(s.escrowOperationId)) return "The per-job endpoint must be one of the endpoints you sell.";
  return null;
}

function stringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

export function parseSelection(body: Record<string, unknown>): EndpointSelection | null {
  const enabledIds = stringArray(body.enabledIds);
  const confirmedNoSideEffectIds = stringArray(body.confirmedNoSideEffectIds);
  const escrow = body.escrowOperationId;
  if (!enabledIds || !confirmedNoSideEffectIds) return null;
  if (escrow !== null && typeof escrow !== "string") return null;
  return { enabledIds, confirmedNoSideEffectIds, escrowOperationId: escrow };
}
```

- [ ] **Step 4: Run the tests (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/money.test.ts lib/copy.test.ts lib/flow.test.ts lib/endpoints.test.ts`
Expected: PASS (all tests in 4 files).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib
git commit -m "feat(web): money parsing in micros, plain-English copy, flow and endpoint selection helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Signed session cookie, login challenge tokens and HTTP helpers

**Files:**
- Create: `apps/web/lib/session.ts`, `apps/web/lib/http.ts`, `apps/web/test/requests.ts`, `apps/web/test/http.ts`
- Test: `apps/web/lib/session.test.ts`

**Interfaces:**
- Consumes: `env.sessionSecret()`, `env.webBaseUrl()`, `env.secureCookies()` (Task 2).
- Produces:
  - `SESSION_COOKIE = "hk_session"`; `type SessionInfo = { sellerId: string; addr: string }`
  - `createSessionToken(sellerId: string, addr: string, nowS?: number): string`; `readSessionToken(token: string, nowS?: number): SessionInfo | null`
  - `sessionCookieHeader(token: string): string`; `clearSessionCookieHeader(): string`; `readCookie(header: string | null, name: string): string | null`
  - `buildLoginMessage(addr: string, nonce: string, expiresIso: string): string`; `issueLoginChallenge(addr: string, nowS?: number): { message: string; nonceToken: string }`; `openLoginChallenge(nonceToken: string, nowS?: number): { addr: string; message: string } | null`
  - `json(data, status?, headers?): Response`; `errorJson(status, message): Response`; `readJson(req): Promise<Record<string, unknown> | null>`; `requireSeller(req): SessionInfo | Response`; `type ApiRouteContext = { params: Promise<{ apiId: string }> }`
  - Test helpers: `jsonRequest(path, init?)`, `ctx(apiId)`, `cookieFor(seller)`, `jsonResponse(data, status?)`

- [ ] **Step 1: Write the failing test**

`apps/web/lib/session.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  buildLoginMessage, clearSessionCookieHeader, createSessionToken, issueLoginChallenge, openLoginChallenge,
  readCookie, readSessionToken, sessionCookieHeader,
} from "./session";

const ADDR = "addr_test1qqexampleexampleexample";
const NOW = 1_800_000_000;

describe("session tokens", () => {
  it("round-trips a seller session", () => {
    const token = createSessionToken("sel_1", ADDR, NOW);
    expect(readSessionToken(token, NOW + 60)).toEqual({ sellerId: "sel_1", addr: ADDR });
  });

  it("rejects a tampered token", () => {
    const [body, sig] = createSessionToken("sel_1", ADDR, NOW).split(".");
    const forged = Buffer.from(JSON.stringify({ sid: "sel_2", addr: ADDR, exp: NOW + 999 })).toString("base64url");
    expect(readSessionToken(`${forged}.${sig}`, NOW)).toBeNull();
    expect(readSessionToken(`${body}.${sig}x`, NOW)).toBeNull();
    expect(readSessionToken("garbage", NOW)).toBeNull();
  });

  it("expires after 7 days", () => {
    const token = createSessionToken("sel_1", ADDR, NOW);
    expect(readSessionToken(token, NOW + 7 * 24 * 3600 + 1)).toBeNull();
  });

  it("never accepts a login token as a session", () => {
    const { nonceToken } = issueLoginChallenge(ADDR, NOW);
    expect(readSessionToken(nonceToken, NOW)).toBeNull();
  });
});

describe("login challenge", () => {
  it("rebuilds the exact message the wallet was asked to sign", () => {
    const { message, nonceToken } = issueLoginChallenge(ADDR, NOW);
    expect(openLoginChallenge(nonceToken, NOW + 10)).toEqual({ addr: ADDR, message });
    expect(message).toContain(ADDR);
    expect(message).toContain("moves no funds");
    expect(message).toContain("Site: web.hirakumi.test");
  });

  it("expires after 5 minutes", () => {
    const { nonceToken } = issueLoginChallenge(ADDR, NOW);
    expect(openLoginChallenge(nonceToken, NOW + 301)).toBeNull();
  });

  it("does not accept a session token as a login challenge", () => {
    expect(openLoginChallenge(createSessionToken("sel_1", ADDR, NOW), NOW)).toBeNull();
  });

  it("builds a readable message", () => {
    expect(buildLoginMessage(ADDR, "ab12", "2026-10-06T12:00:00.000Z")).toBe(
      [
        "Sign in to Hirakumi",
        "This proves you control this wallet. It costs nothing and moves no funds.",
        "Site: web.hirakumi.test",
        `Wallet: ${ADDR}`,
        "Network: cardano:preprod",
        "Nonce: ab12",
        "Expires: 2026-10-06T12:00:00.000Z",
      ].join("\n"),
    );
  });
});

describe("cookies", () => {
  it("sets an HttpOnly, SameSite=Lax cookie for 7 days", () => {
    const header = sessionCookieHeader("tok");
    expect(header).toBe("hk_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800");
    expect(clearSessionCookieHeader()).toBe("hk_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  });

  it("reads one cookie from a Cookie header", () => {
    expect(readCookie("a=1; hk_session=xyz.abc; b=2", "hk_session")).toBe("xyz.abc");
    expect(readCookie(null, "hk_session")).toBeNull();
    expect(readCookie("a=1", "hk_session")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/session.test.ts`
Expected: FAIL, `Failed to resolve import "./session"`.

- [ ] **Step 3: Write the implementation and helpers**

`apps/web/lib/session.ts`:
```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const SESSION_COOKIE = "hk_session";
const SESSION_TTL_S = 7 * 24 * 3600;
const LOGIN_TTL_S = 5 * 60;

export type SessionInfo = { sellerId: string; addr: string };
type SessionPayload = { sid: string; addr: string; exp: number };
type LoginPayload = { addr: string; nonce: string; exp: number };

const nowSeconds = () => Math.floor(Date.now() / 1000);

function mac(kind: "session" | "login", body: string): Buffer {
  return createHmac("sha256", env.sessionSecret()).update(`${kind}.${body}`).digest();
}

function seal(kind: "session" | "login", payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(kind, body).toString("base64url")}`;
}

function unseal<T extends { exp: number }>(kind: "session" | "login", token: string, now: number): T | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = mac(kind, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  return payload;
}

export function createSessionToken(sellerId: string, addr: string, now = nowSeconds()): string {
  return seal("session", { sid: sellerId, addr, exp: now + SESSION_TTL_S } satisfies SessionPayload);
}

export function readSessionToken(token: string, now = nowSeconds()): SessionInfo | null {
  const p = unseal<SessionPayload>("session", token, now);
  if (!p || typeof p.sid !== "string" || typeof p.addr !== "string") return null;
  return { sellerId: p.sid, addr: p.addr };
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}${env.secureCookies() ? "; Secure" : ""}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${env.secureCookies() ? "; Secure" : ""}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function buildLoginMessage(addr: string, nonce: string, expiresIso: string): string {
  return [
    "Sign in to Hirakumi",
    "This proves you control this wallet. It costs nothing and moves no funds.",
    `Site: ${new URL(env.webBaseUrl()).host}`,
    `Wallet: ${addr}`,
    "Network: cardano:preprod",
    `Nonce: ${nonce}`,
    `Expires: ${expiresIso}`,
  ].join("\n");
}

export function issueLoginChallenge(addr: string, now = nowSeconds()): { message: string; nonceToken: string } {
  const nonce = randomBytes(16).toString("hex");
  const exp = now + LOGIN_TTL_S;
  return {
    message: buildLoginMessage(addr, nonce, new Date(exp * 1000).toISOString()),
    nonceToken: seal("login", { addr, nonce, exp } satisfies LoginPayload),
  };
}

export function openLoginChallenge(nonceToken: string, now = nowSeconds()): { addr: string; message: string } | null {
  const p = unseal<LoginPayload>("login", nonceToken, now);
  if (!p || typeof p.addr !== "string" || typeof p.nonce !== "string") return null;
  return { addr: p.addr, message: buildLoginMessage(p.addr, p.nonce, new Date(p.exp * 1000).toISOString()) };
}
```

`apps/web/lib/http.ts`:
```ts
import { readCookie, readSessionToken, SESSION_COOKIE, type SessionInfo } from "./session";

export type ApiRouteContext = { params: Promise<{ apiId: string }> };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

export function errorJson(status: number, message: string): Response {
  return json({ error: message }, status);
}

const MAX_BODY_BYTES = 64 * 1024;

/** JSON bodies only. Requiring application/json also blocks cross-site form posts (CSRF). */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return null;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function requireSeller(req: Request): SessionInfo | Response {
  const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  const session = token ? readSessionToken(token) : null;
  return session ?? errorJson(401, "Please sign in with your wallet again.");
}
```

`apps/web/test/requests.ts`:
```ts
import { createSessionToken } from "@/lib/session";
import type { Seller } from "@/lib/types";

export function jsonRequest(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://web.hirakumi.test${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

export function ctx(apiId: string): { params: Promise<{ apiId: string }> } {
  return { params: Promise.resolve({ apiId }) };
}

export function cookieFor(seller: Seller): string {
  return `hk_session=${createSessionToken(seller.id, seller.cardanoAddr)}`;
}
```

`apps/web/test/http.ts`:
```ts
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 4: Run the test (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/session.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/session.ts apps/web/lib/session.test.ts apps/web/lib/http.ts apps/web/test/requests.ts apps/web/test/http.ts
git commit -m "feat(web): HMAC-signed seller session and login challenge tokens" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Cardano address normalisation and CIP-30 signature verification

**Files:**
- Create: `apps/web/lib/cardano.ts`, `apps/web/test/wallet-fixture.ts`
- Test: `apps/web/lib/cardano.test.ts`

**Interfaces:**
- Consumes: `@meshsdk/core-cst@1.9.1`: `checkSignature`, `deserializeAddress`, `addressToBech32`, `signData`, `buildEd25519PrivateKeyFromSecretKey`, `buildBaseAddress`, `Hash28ByteBase16` (all verified, see "External APIs verified").
- Produces:
  - `class AddressError extends Error`; `toPreprodBech32(input: string): string` (hex or bech32 in, `addr_test1…` out, else `AddressError` with plain-English message)
  - `type Cip30Signature = { signature: string; key: string }`; `utf8ToHex(s: string): string`; `verifyCip30Signature(message: string, sig: Cip30Signature, bech32: string): Promise<boolean>`
  - Test fixture: `type TestWallet = { bech32: string; addressHex: string; sign(message: string): Cip30Signature; signHex(payloadHex: string): Cip30Signature }`; `makeTestWallet(networkId?: 0 | 1): Promise<TestWallet>`

- [ ] **Step 1: Write the wallet fixture and the failing test**

`apps/web/test/wallet-fixture.ts`:
```ts
import { randomBytes } from "node:crypto";
import {
  buildBaseAddress, buildEd25519PrivateKeyFromSecretKey, checkSignature, Hash28ByteBase16, signData,
} from "@meshsdk/core-cst";

export type TestWallet = {
  bech32: string;
  addressHex: string;
  sign(message: string): { signature: string; key: string };
  signHex(payloadHex: string): { signature: string; key: string };
};

let sodiumReady = false;

/** checkSignature awaits libsodium's ready() before parsing, so one call with junk input initialises it. */
async function ensureSodium(): Promise<void> {
  if (sodiumReady) return;
  await checkSignature("00", { signature: "00", key: "00" }).catch(() => undefined);
  sodiumReady = true;
}

/** A software wallet that produces CIP-30 style COSE_Sign1 signatures, like Eternl does. */
export async function makeTestWallet(networkId: 0 | 1 = 0): Promise<TestWallet> {
  await ensureSodium();
  const payment = buildEd25519PrivateKeyFromSecretKey(randomBytes(32).toString("hex"));
  const stake = buildEd25519PrivateKeyFromSecretKey(randomBytes(32).toString("hex"));
  const address = buildBaseAddress(
    networkId,
    Hash28ByteBase16(payment.toPublic().hash().hex()),
    Hash28ByteBase16(stake.toPublic().hash().hex()),
  ).toAddress();
  const signHex = (payloadHex: string) => signData(payloadHex, { address, key: payment });
  return {
    bech32: address.toBech32(),
    addressHex: address.toBytes(),
    signHex,
    sign: (message: string) => signHex(Buffer.from(message, "utf8").toString("hex")),
  };
}
```

`apps/web/lib/cardano.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { makeTestWallet } from "@/test/wallet-fixture";
import { AddressError, toPreprodBech32, utf8ToHex, verifyCip30Signature } from "./cardano";

describe("toPreprodBech32", () => {
  it("turns the hex address a CIP-30 wallet returns into bech32", async () => {
    const w = await makeTestWallet();
    expect(toPreprodBech32(w.addressHex)).toBe(w.bech32);
    expect(w.bech32.startsWith("addr_test1")).toBe(true);
  });

  it("accepts a bech32 preprod address unchanged", async () => {
    const w = await makeTestWallet();
    expect(toPreprodBech32(w.bech32)).toBe(w.bech32);
  });

  it("rejects mainnet addresses with a plain-English hint", async () => {
    const mainnet = await makeTestWallet(1);
    expect(() => toPreprodBech32(mainnet.addressHex)).toThrow(AddressError);
    expect(() => toPreprodBech32(mainnet.addressHex)).toThrow("Switch your wallet to the Cardano preprod test network, then try again.");
  });

  it("rejects garbage", () => {
    expect(() => toPreprodBech32("not-an-address")).toThrow("That wallet address could not be read.");
  });
});

describe("verifyCip30Signature", () => {
  it("accepts a signature by the claimed address over the exact message", async () => {
    const w = await makeTestWallet();
    const message = "Sign in to Hirakumi\nNonce: 1";
    expect(await verifyCip30Signature(message, w.sign(message), w.bech32)).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const w = await makeTestWallet();
    expect(await verifyCip30Signature("Nonce: 2", w.sign("Nonce: 1"), w.bech32)).toBe(false);
  });

  it("rejects a signature made by a different wallet", async () => {
    const a = await makeTestWallet();
    const b = await makeTestWallet();
    expect(await verifyCip30Signature("hello", b.sign("hello"), a.bech32)).toBe(false);
  });

  it("returns false (never throws) for malformed input", async () => {
    const w = await makeTestWallet();
    expect(await verifyCip30Signature("hello", { signature: "zz", key: "zz" }, w.bech32)).toBe(false);
    expect(await verifyCip30Signature("hello", { signature: "84a4", key: "a401" }, w.bech32)).toBe(false);
  });

  it("encodes text as UTF-8 hex the same way the browser does", () => {
    expect(utf8ToHex("Hé")).toBe("48c3a9");
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/cardano.test.ts`
Expected: FAIL, `Failed to resolve import "./cardano"`.

- [ ] **Step 3: Write the implementation**

`apps/web/lib/cardano.ts`:
```ts
import { addressToBech32, checkSignature, deserializeAddress } from "@meshsdk/core-cst";

export class AddressError extends Error {}

export type Cip30Signature = { signature: string; key: string };

const HEX = /^[0-9a-fA-F]+$/;

/** CIP-30 wallets hand out hex address bytes; sellers are stored as bech32. Preprod only. */
export function toPreprodBech32(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 20 || trimmed.length > 256) throw new AddressError("That wallet address could not be read.");
  let bech32: string;
  try {
    bech32 = addressToBech32(deserializeAddress(trimmed));
  } catch {
    throw new AddressError("That wallet address could not be read.");
  }
  if (!bech32.startsWith("addr_test1")) {
    throw new AddressError("Switch your wallet to the Cardano preprod test network, then try again.");
  }
  return bech32;
}

export function utf8ToHex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}

/**
 * Verifies a CIP-30 signData result. The wallet signed utf8ToHex(message), and we pass that same hex
 * so Mesh compares bytes directly. Passing `bech32` makes Mesh check that the signing key's hash
 * matches the address's payment credential.
 */
export async function verifyCip30Signature(message: string, sig: Cip30Signature, bech32: string): Promise<boolean> {
  if (!HEX.test(sig.signature) || !HEX.test(sig.key)) return false;
  try {
    return await checkSignature(utf8ToHex(message), sig, bech32);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/cardano.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/cardano.ts apps/web/lib/cardano.test.ts apps/web/test/wallet-fixture.ts
git commit -m "feat(web): preprod address normalisation and CIP-30 signature verification via Mesh checkSignature" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Wallet sign-in (routes, browser wallet client, login screen)

**Files:**
- Create: `apps/web/lib/repo/sellers.ts`, `apps/web/app/api/auth/nonce/route.ts`, `apps/web/app/api/auth/verify/route.ts`, `apps/web/app/api/auth/logout/route.ts`, `apps/web/lib/client-fetch.ts`, `apps/web/lib/wallet-client.ts`, `apps/web/components/wallet-login.tsx`, `apps/web/app/login/page.tsx`
- Test: `apps/web/app/api/auth/auth.test.ts`, `apps/web/components/wallet-login.test.tsx`

**Interfaces:**
- Consumes: `toPreprodBech32`, `verifyCip30Signature`, `AddressError` (Task 5); `issueLoginChallenge`, `openLoginChallenge`, `createSessionToken`, `sessionCookieHeader`, `clearSessionCookieHeader` (Task 4); `json`, `errorJson`, `readJson` (Task 4); `safeNextPath` (Task 3); `newId` (`@hirakumi/core`).
- Produces:
  - `upsertSeller(sql: Sql, cardanoAddr: string): Promise<Seller>`
  - `POST /api/auth/nonce` body `{ address: string }` → 200 `{ address, message, nonceToken }` | 400 `{ error }`
  - `POST /api/auth/verify` body `{ nonceToken, signature, key }` → 200 `{ sellerId, address }` + `Set-Cookie: hk_session=…` | 400/401 `{ error }`
  - `POST /api/auth/logout` → 303 to `/login` and clears the cookie
  - `class RequestError extends Error`; `postJson<T>(url: string, body: unknown): Promise<T>`; `getJson<T>(url: string): Promise<T>`
  - `type Cip30Api`, `type WalletInfo`, `class WalletError`, `listWallets(): WalletInfo[]`, `connectWallet(id: string): Promise<{ api: Cip30Api; addressHex: string }>`, `textToHex(s: string): string`, `signText(api, addressHex, text): Promise<{ signature: string; key: string }>`, `walletErrorMessage(e: unknown): string`
  - `<WalletLogin next: string />`

- [ ] **Step 1: Write the failing route test**

`apps/web/app/api/auth/auth.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { issueLoginChallenge } from "@/lib/session";
import { resetDb } from "@/test/db";
import { jsonRequest } from "@/test/requests";
import { makeTestWallet } from "@/test/wallet-fixture";
import { POST as logout } from "./logout/route";
import { POST as nonce } from "./nonce/route";
import { POST as verify } from "./verify/route";

async function getNonce(address: string) {
  const res = await nonce(jsonRequest("/api/auth/nonce", { body: { address } }));
  return { res, body: (await res.json()) as { address: string; message: string; nonceToken: string; error?: string } };
}

describe("wallet sign-in", () => {
  beforeEach(resetDb);

  it("signs in a seller whose wallet signs the login message", async () => {
    const w = await makeTestWallet();
    const { res, body } = await getNonce(w.addressHex);
    expect(res.status).toBe(200);
    expect(body.address).toBe(w.bech32);
    expect(body.message).toContain(w.bech32);

    const v = await verify(jsonRequest("/api/auth/verify", { body: { nonceToken: body.nonceToken, ...w.sign(body.message) } }));
    expect(v.status).toBe(200);
    expect(v.headers.get("set-cookie")).toMatch(/^hk_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
    const [row] = await getSql()<{ cardanoAddr: string }[]>`select cardano_addr from sellers`;
    expect(row.cardanoAddr).toBe(w.bech32);
  });

  it("signing in twice reuses the same seller", async () => {
    const w = await makeTestWallet();
    for (let i = 0; i < 2; i++) {
      const { body } = await getNonce(w.addressHex);
      await verify(jsonRequest("/api/auth/verify", { body: { nonceToken: body.nonceToken, ...w.sign(body.message) } }));
    }
    const [{ count }] = await getSql()<{ count: number }[]>`select count(*)::int as count from sellers`;
    expect(count).toBe(1);
  });

  it("rejects a signature from a different wallet", async () => {
    const owner = await makeTestWallet();
    const attacker = await makeTestWallet();
    const { body } = await getNonce(owner.addressHex);
    const v = await verify(jsonRequest("/api/auth/verify", { body: { nonceToken: body.nonceToken, ...attacker.sign(body.message) } }));
    expect(v.status).toBe(401);
    expect(((await v.json()) as { error: string }).error).toMatch(/signature didn't match/);
    expect(v.headers.get("set-cookie")).toBeNull();
  });

  it("rejects mainnet wallets in plain English", async () => {
    const w = await makeTestWallet(1);
    const { res, body } = await getNonce(w.addressHex);
    expect(res.status).toBe(400);
    expect(body.error).toBe("Switch your wallet to the Cardano preprod test network, then try again.");
  });

  it("rejects an expired sign-in request", async () => {
    const w = await makeTestWallet();
    const old = issueLoginChallenge(w.bech32, Math.floor(Date.now() / 1000) - 600);
    const v = await verify(jsonRequest("/api/auth/verify", { body: { nonceToken: old.nonceToken, ...w.sign(old.message) } }));
    expect(v.status).toBe(401);
    expect(((await v.json()) as { error: string }).error).toBe("This sign-in request expired. Start again.");
  });

  it("logs out by clearing the cookie and redirecting", async () => {
    const res = await logout(new Request("https://web.hirakumi.test/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run app/api/auth/auth.test.ts`
Expected: FAIL, `Failed to resolve import "./logout/route"`.

- [ ] **Step 3: Write the seller repo and the three routes**

`apps/web/lib/repo/sellers.ts`:
```ts
import { newId } from "@hirakumi/core";
import type { Sql } from "../db";
import type { Seller } from "../types";

export async function upsertSeller(sql: Sql, cardanoAddr: string): Promise<Seller> {
  const [row] = await sql<Seller[]>`
    insert into sellers (id, cardano_addr) values (${newId("sel")}, ${cardanoAddr})
    on conflict (cardano_addr) do update set cardano_addr = excluded.cardano_addr
    returning id, cardano_addr`;
  return row;
}
```

`apps/web/app/api/auth/nonce/route.ts`:
```ts
import { AddressError, toPreprodBech32 } from "@/lib/cardano";
import { errorJson, json, readJson } from "@/lib/http";
import { issueLoginChallenge } from "@/lib/session";

export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body || typeof body.address !== "string") return errorJson(400, "Connect a wallet first.");
  let addr: string;
  try {
    addr = toPreprodBech32(body.address);
  } catch (e) {
    if (e instanceof AddressError) return errorJson(400, e.message);
    throw e;
  }
  const { message, nonceToken } = issueLoginChallenge(addr);
  return json({ address: addr, message, nonceToken });
}
```

`apps/web/app/api/auth/verify/route.ts`:
```ts
import { verifyCip30Signature } from "@/lib/cardano";
import { getSql } from "@/lib/db";
import { errorJson, json, readJson } from "@/lib/http";
import { upsertSeller } from "@/lib/repo/sellers";
import { createSessionToken, openLoginChallenge, sessionCookieHeader } from "@/lib/session";

export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body || typeof body.nonceToken !== "string" || typeof body.signature !== "string" || typeof body.key !== "string") {
    return errorJson(400, "The sign-in request was incomplete. Try again.");
  }
  const challenge = openLoginChallenge(body.nonceToken);
  if (!challenge) return errorJson(401, "This sign-in request expired. Start again.");
  const ok = await verifyCip30Signature(challenge.message, { signature: body.signature, key: body.key }, challenge.addr);
  if (!ok) {
    return errorJson(401, "The wallet signature didn't match. Make sure you signed with the same wallet account you connected.");
  }
  const seller = await upsertSeller(getSql(), challenge.addr);
  return json(
    { sellerId: seller.id, address: seller.cardanoAddr },
    200,
    { "set-cookie": sessionCookieHeader(createSessionToken(seller.id, seller.cardanoAddr)) },
  );
}
```

`apps/web/app/api/auth/logout/route.ts`:
```ts
import { clearSessionCookieHeader } from "@/lib/session";

export async function POST(_req: Request): Promise<Response> {
  return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": clearSessionCookieHeader() } });
}
```

- [ ] **Step 4: Run the route test (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run app/api/auth/auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing component test**

`apps/web/components/wallet-login.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cip30Api } from "@/lib/wallet-client";
import { jsonResponse } from "@/test/http";
import { WalletLogin } from "./wallet-login";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

function installWallet(api: Partial<Cip30Api> = {}) {
  window.cardano = {
    testwallet: {
      name: "Test Wallet",
      icon: "",
      enable: async () => ({
        getNetworkId: async () => 0,
        getChangeAddress: async () => "00abcd",
        getUsedAddresses: async () => ["00abcd"],
        signData: async () => ({ signature: "84a1", key: "a401" }),
        ...api,
      }),
    },
  };
}

afterEach(() => {
  delete window.cardano;
  vi.unstubAllGlobals();
  nav.push.mockReset();
});

describe("WalletLogin", () => {
  it("tells the seller to install a wallet when none is present", async () => {
    render(<WalletLogin next="/apis" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No Cardano wallet found in this browser");
  });

  it("signs the server's message and goes to the next page", async () => {
    const signData = vi.fn(async () => ({ signature: "84a1", key: "a401" }));
    installWallet({ signData });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ address: "addr_test1qq", message: "Sign in to Hirakumi", nonceToken: "n.t" }))
      .mockResolvedValueOnce(jsonResponse({ sellerId: "sel_1", address: "addr_test1qq" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<WalletLogin next="/apis/api_1" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));

    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1"));
    expect(signData).toHaveBeenCalledWith("00abcd", Buffer.from("Sign in to Hirakumi").toString("hex"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ address: "00abcd" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ nonceToken: "n.t", signature: "84a1", key: "a401" });
  });

  it("explains a cancelled signature", async () => {
    installWallet({ signData: async () => Promise.reject({ code: 3, info: "user declined" }) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ address: "a", message: "m", nonceToken: "n" })));
    render(<WalletLogin next="/apis" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You cancelled signing in your wallet. Nothing was signed.");
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("refuses a wallet on mainnet before asking the server", async () => {
    installWallet({ getNetworkId: async () => 1 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<WalletLogin next="/apis" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your wallet is on mainnet. Switch it to the preprod test network");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's plain-English error", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "Switch your wallet to the Cardano preprod test network, then try again." }, 400)));
    render(<WalletLogin next="/apis" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Switch your wallet to the Cardano preprod test network");
  });
});
```

- [ ] **Step 6: Run the component test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run components/wallet-login.test.tsx`
Expected: FAIL, `Failed to resolve import "@/lib/wallet-client"`.

- [ ] **Step 7: Write the browser helpers, component and page**

`apps/web/lib/client-fetch.ts`:
```ts
/** Thrown with a message that is safe to show the seller verbatim. */
export class RequestError extends Error {}

async function handle<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new RequestError(data.error ?? "Something went wrong. Try again.");
  return data;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new RequestError("We couldn't reach Hirakumi. Check your connection and try again.");
  }
  return handle<T>(res);
}

export async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    throw new RequestError("We couldn't reach Hirakumi. Check your connection and try again.");
  }
  return handle<T>(res);
}
```

`apps/web/lib/wallet-client.ts`:
```ts
import { RequestError } from "./client-fetch";

/** The subset of the CIP-30 API Hirakumi uses (see connect-wallet skill reference). */
export type Cip30Api = {
  getNetworkId(): Promise<number>;
  getChangeAddress(): Promise<string>;
  getUsedAddresses(): Promise<string[]>;
  signData(addr: string, payloadHex: string): Promise<{ signature: string; key: string }>;
};

type InjectedWallet = { name: string; icon?: string; apiVersion?: string; enable(): Promise<Cip30Api> };

declare global {
  interface Window {
    cardano?: Record<string, InjectedWallet | undefined>;
  }
}

export type WalletInfo = { id: string; name: string; icon: string };

export class WalletError extends Error {}

export function listWallets(): WalletInfo[] {
  if (typeof window === "undefined" || !window.cardano) return [];
  return Object.entries(window.cardano)
    .filter(([, w]) => !!w && typeof w.enable === "function" && typeof w.name === "string")
    .map(([id, w]) => ({ id, name: w!.name, icon: w!.icon ?? "" }));
}

export async function connectWallet(id: string): Promise<{ api: Cip30Api; addressHex: string }> {
  const injected = window.cardano?.[id];
  if (!injected) throw new WalletError("That wallet isn't available any more. Reload the page.");
  const api = await injected.enable();
  if ((await api.getNetworkId()) !== 0) {
    throw new WalletError("Your wallet is on mainnet. Switch it to the preprod test network, then try again.");
  }
  return { api, addressHex: await api.getChangeAddress() };
}

export function textToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function signText(api: Cip30Api, addressHex: string, text: string): Promise<{ signature: string; key: string }> {
  return api.signData(addressHex, textToHex(text));
}

export function walletErrorMessage(e: unknown): string {
  if (e instanceof WalletError || e instanceof RequestError) return e.message;
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "number") {
    switch ((e as { code: number }).code) {
      case -3:
        return "You declined the connection in your wallet. Try again and choose Connect.";
      case -4:
        return "Your wallet account changed. Try again.";
      case 3:
        return "You cancelled signing in your wallet. Nothing was signed.";
      case 2:
        return "This wallet address can't sign messages. Use a normal payment address.";
      default:
        return "Your wallet reported a problem. Try again.";
    }
  }
  return "Something went wrong with your wallet. Try again.";
}
```

`apps/web/components/wallet-login.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/client-fetch";
import { connectWallet, listWallets, signText, walletErrorMessage, type WalletInfo } from "@/lib/wallet-client";

type Phase = { kind: "idle" } | { kind: "working"; text: string } | { kind: "error"; text: string };

export function WalletLogin({ next }: { next: string }) {
  const router = useRouter();
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    // Extensions inject window.cardano asynchronously; look again shortly after load.
    setWallets(listWallets());
    const t = setTimeout(() => setWallets(listWallets()), 800);
    return () => clearTimeout(t);
  }, []);

  async function signIn(walletId: string) {
    try {
      setPhase({ kind: "working", text: "Connecting to your wallet…" });
      const { api, addressHex } = await connectWallet(walletId);
      const challenge = await postJson<{ message: string; nonceToken: string }>("/api/auth/nonce", { address: addressHex });
      setPhase({ kind: "working", text: "Approve the sign-in message in your wallet. It costs nothing and moves no funds." });
      const sig = await signText(api, addressHex, challenge.message);
      await postJson("/api/auth/verify", { nonceToken: challenge.nonceToken, ...sig });
      router.push(next);
    } catch (e) {
      setPhase({ kind: "error", text: walletErrorMessage(e) });
    }
  }

  if (wallets === null) return null;
  if (wallets.length === 0) {
    return (
      <p role="alert" className="text-sm">
        No Cardano wallet found in this browser. Install Eternl, switch it to the preprod test network, then reload this page.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {wallets.map((w) => (
          <Button key={w.id} disabled={phase.kind === "working"} onClick={() => signIn(w.id)}>
            Sign in with {w.name}
          </Button>
        ))}
      </div>
      {phase.kind === "working" && <p role="status" className="text-sm text-muted-foreground">{phase.text}</p>}
      {phase.kind === "error" && <p role="alert" className="text-sm text-destructive">{phase.text}</p>}
    </div>
  );
}
```

`apps/web/app/login/page.tsx`:
```tsx
import { WalletLogin } from "@/components/wallet-login";
import { safeNextPath } from "@/lib/flow";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <section className="max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold">Sign in with your Cardano wallet</h1>
      <p className="text-muted-foreground">
        Your wallet address is your account. Buyers pay this address directly. Signing in asks your wallet to sign a
        short message; it costs nothing and moves no funds.
      </p>
      <WalletLogin next={safeNextPath(next)} />
    </section>
  );
}
```

- [ ] **Step 8: Run both tests and the build (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run app/api/auth/auth.test.ts components/wallet-login.test.tsx && pnpm --filter @hirakumi/web build`
Expected: PASS (11 tests) and a successful build listing `/login`, `/api/auth/nonce`, `/api/auth/verify`, `/api/auth/logout`. If the build fails to bundle `@meshsdk/core-cst`, check that `serverExternalPackages` in `next.config.ts` includes it.

- [ ] **Step 9: Spike — real Eternl signature (spec §12, P2 row)**

Run `pnpm --filter @hirakumi/web dev` with a local `.env.local` in `apps/web` (values as in `test/env.ts`, but with `DATABASE_URL=postgres://hirakumi:hirakumi@localhost:5432/hirakumi` and `WEB_BASE_URL=http://localhost:3000`). Open `http://localhost:3000/login` in a browser with Eternl set to **preprod**, click "Sign in with eternl" and approve.
Expected: the browser goes to `/apis` (a 404 page is fine until Task 7), and `psql $DATABASE_URL -c "select cardano_addr from sellers"` shows your `addr_test1…` address.
**If the server answers "The wallet signature didn't match"** with a real Eternl wallet, although Task 5's Mesh round trip passes, switch to the fallback verifier. Run `pnpm --filter @hirakumi/web add -E @cardano-foundation/cardano-verify-datasignature@1.0.11`, then replace the body of `verifyCip30Signature` in `lib/cardano.ts` with the code below. Re-run `lib/cardano.test.ts` (it must still pass) and repeat this step. Post the outcome in team chat.
```ts
import verifySignature from "@cardano-foundation/cardano-verify-datasignature";

export async function verifyCip30Signature(message: string, sig: Cip30Signature, bech32: string): Promise<boolean> {
  if (!HEX.test(sig.signature) || !HEX.test(sig.key)) return false;
  try {
    return verifySignature(sig.signature, sig.key, message, bech32); // plain-text message, verified to agree with Mesh
  } catch {
    return false;
  }
}
```

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): wallet sign-in with CIP-30 signData and a signed session cookie" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Setup screen, API list, step router and shared state components

**Files:**
- Create: `apps/web/lib/repo/apis.ts`, `apps/web/lib/validate.ts`, `apps/web/lib/route-helpers.ts`, `apps/web/lib/page-auth.ts`, `apps/web/app/api/apis/route.ts`, `apps/web/components/states.tsx`, `apps/web/components/auto-refresh.tsx`, `apps/web/components/step-list.tsx`, `apps/web/components/health-badge.tsx`, `apps/web/components/api-nav.tsx`, `apps/web/components/setup-form.tsx`, `apps/web/app/apis/page.tsx`, `apps/web/app/apis/new/page.tsx`, `apps/web/app/apis/[apiId]/page.tsx`, `apps/web/app/apis/[apiId]/layout.tsx`
- Test: `apps/web/lib/validate.test.ts`, `apps/web/app/api/apis/apis.test.ts`, `apps/web/components/setup-form.test.tsx`, `apps/web/components/health-badge.test.tsx`

**Interfaces:**
- Consumes: `requireSeller`, `json`, `errorJson`, `readJson`, `ApiRouteContext`, `SessionInfo` (Task 4); `STATE_LABEL`, `healthLabel`, `STEP_STATUS_LABEL`, `humanizeStep`, `shortAddress` (Task 3); `isStale`, `stepForState` (Task 3); `env` (Task 2); `newId` (`@hirakumi/core`).
- Produces:
  - `API_COLUMNS: string[]`; `createApi(sql, { sellerId, name, origin, openapiUrl }): Promise<{ api: Api; created: boolean }>`; `getApiForSeller(sql, apiId, sellerId): Promise<Api | null>`; `getLiveApi(sql, apiId): Promise<Api | null>`; `listApisForSeller(sql, sellerId): Promise<Api[]>`; `transitionState(sql, { apiId, sellerId, from: ApiState[], to: ApiState }): Promise<boolean>`; `listOnboardSteps(sql, apiId): Promise<OnboardStep[]>`
  - `class ValidationError`; `validateOpenApiUrl(raw: unknown, allowInsecure: boolean): { url: string; origin: string; hostname: string }`; `validateApiName(raw: unknown, fallback: string): string`
  - `loadOwnedApi(req, ctx): Promise<{ session: SessionInfo; api: Api; sql: Sql } | Response>`; `wrongStep(api: Api): Response`
  - `requireSellerPage(nextPath): Promise<SessionInfo>`; `loadApiPage(apiId, nextPath): Promise<{ session: SessionInfo; api: Api }>`
  - `POST /api/apis` body `{ openapiUrl: string; name?: string }` → 201 `{ apiId, state: "intake", created: true }` | 200 `{ apiId, state, created: false }` (same link again) | 400/401 `{ error }`
  - Components: `<WaitingState title detail? children? />`, `<ErrorState title detail action? />`, `<EmptyState title detail action? />`, `<AutoRefresh everyMs />`, `<StepList steps />`, `<HealthBadge state health checkedAt now? />`, `<ApiNav apiId />`, `<SetupForm initialUrl />`

- [ ] **Step 1: Write the failing tests**

`apps/web/lib/validate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { validateApiName, validateOpenApiUrl, ValidationError } from "./validate";

describe("validateOpenApiUrl", () => {
  it("accepts https links and derives the origin", () => {
    expect(validateOpenApiUrl(" https://price.example.dev/openapi.json#top ", false)).toEqual({
      url: "https://price.example.dev/openapi.json",
      origin: "https://price.example.dev",
      hostname: "price.example.dev",
    });
  });

  it.each([
    ["", "Paste the link to your OpenAPI description."],
    ["not a url", "That doesn't look like a web link. It should start with https://"],
    ["http://price.example.dev/openapi.json", "The link must start with https://"],
    ["https://user:pw@price.example.dev/openapi.json", "Remove the username and password from the link. Hirakumi only supports public API descriptions."],
  ])("rejects %j", (input, message) => {
    expect(() => validateOpenApiUrl(input, false)).toThrow(ValidationError);
    expect(() => validateOpenApiUrl(input, false)).toThrow(message);
  });

  it("allows http://localhost only when insecure upstreams are allowed", () => {
    expect(() => validateOpenApiUrl("http://localhost:4000/openapi.json", false)).toThrow("The link must start with https://");
    expect(validateOpenApiUrl("http://localhost:4000/openapi.json", true).origin).toBe("http://localhost:4000");
  });
});

describe("validateApiName", () => {
  it("falls back to the hostname and limits length", () => {
    expect(validateApiName(undefined, "price.example.dev")).toBe("price.example.dev");
    expect(validateApiName("  Price API ", "x")).toBe("Price API");
    expect(() => validateApiName("x".repeat(81), "x")).toThrow("Keep the name under 80 characters.");
  });
});
```

`apps/web/app/api/apis/apis.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedSeller } from "@/test/factories";
import { cookieFor, jsonRequest } from "@/test/requests";
import { POST } from "./route";

describe("POST /api/apis (Setup)", () => {
  beforeEach(resetDb);

  it("requires a signed-in seller", async () => {
    const res = await POST(jsonRequest("/api/apis", { body: { openapiUrl: "https://price.example.dev/openapi.json" } }));
    expect(res.status).toBe(401);
  });

  it("creates the API in intake for the signed-in seller", async () => {
    const seller = await seedSeller();
    const res = await POST(jsonRequest("/api/apis", {
      cookie: cookieFor(seller),
      body: { openapiUrl: "https://price.example.dev/openapi.json", name: "Price API" },
    }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { apiId: string; state: string; created: boolean };
    expect(body).toMatchObject({ state: "intake", created: true });
    const [row] = await getSql()<{ sellerId: string; origin: string; state: string; name: string }[]>`
      select seller_id, origin, state, name from apis where id = ${body.apiId}`;
    expect(row).toEqual({ sellerId: seller.id, origin: "https://price.example.dev", state: "intake", name: "Price API" });
  });

  it("the same link twice returns the same API instead of a duplicate", async () => {
    const seller = await seedSeller();
    const send = () => POST(jsonRequest("/api/apis", { cookie: cookieFor(seller), body: { openapiUrl: "https://price.example.dev/openapi.json" } }));
    const [a, b] = await Promise.all([send(), send()]);
    const ids = [((await a.json()) as { apiId: string }).apiId, ((await b.json()) as { apiId: string }).apiId];
    expect(ids[0]).toBe(ids[1]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
  });

  it("explains a bad link in plain English", async () => {
    const seller = await seedSeller();
    const res = await POST(jsonRequest("/api/apis", { cookie: cookieFor(seller), body: { openapiUrl: "ftp://x" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The link must start with https://" });
  });
});
```

`apps/web/components/setup-form.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { SetupForm } from "./setup-form";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

afterEach(() => {
  vi.unstubAllGlobals();
  nav.push.mockReset();
});

describe("SetupForm", () => {
  it("submits the link and opens the Endpoints step", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ apiId: "api_1", state: "intake", created: true }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SetupForm initialUrl="" />);
    await user.type(screen.getByLabelText("OpenAPI link"), "https://price.example.dev/openapi.json");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/endpoints"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ openapiUrl: "https://price.example.dev/openapi.json", name: "" });
  });

  it("shows the server's error next to the form", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "The link must start with https://" }, 400)));
    render(<SetupForm initialUrl="http://price.example.dev" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The link must start with https://");
    expect(nav.push).not.toHaveBeenCalled();
  });
});
```

`apps/web/components/health-badge.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthBadge } from "./health-badge";

const now = new Date("2026-10-06T12:00:00Z");

describe("HealthBadge", () => {
  it("says Live for a healthy live API checked recently", () => {
    render(<HealthBadge state="live" health="healthy" checkedAt={new Date("2026-10-06T11:59:00Z")} now={now} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says Down when the monitor marked it down", () => {
    render(<HealthBadge state="live" health="down" checkedAt={new Date("2026-10-06T11:59:00Z")} now={now} />);
    expect(screen.getByText("Down")).toBeInTheDocument();
  });

  it("warns when the last check is older than 10 minutes", () => {
    render(<HealthBadge state="live" health="healthy" checkedAt={new Date("2026-10-06T11:40:00Z")} now={now} />);
    expect(screen.getByRole("note")).toHaveTextContent("The last health check was more than 10 minutes ago");
  });

  it("shows the onboarding stage before the API is live", () => {
    render(<HealthBadge state="registering" health="healthy" checkedAt={null} now={now} />);
    expect(screen.getByText("Registering on the Masumi network")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/validate.test.ts app/api/apis/apis.test.ts components/setup-form.test.tsx components/health-badge.test.tsx`
Expected: FAIL, `Failed to resolve import "./validate"`, `"./route"`, `"./setup-form"`, `"./health-badge"`.

- [ ] **Step 3: Write the repo, validation and helpers**

`apps/web/lib/repo/apis.ts`:
```ts
import { newId } from "@hirakumi/core";
import type { Sql } from "../db";
import type { Api, ApiState, OnboardStep } from "../types";

export const API_COLUMNS = [
  "id", "seller_id", "name", "origin", "openapi_url", "state", "health",
  "health_checked_at", "escrow_op_id", "agent_identifier", "created_at",
];

export async function createApi(
  sql: Sql,
  input: { sellerId: string; name: string; origin: string; openapiUrl: string },
): Promise<{ api: Api; created: boolean }> {
  return sql.begin(async (tx) => {
    // Serialise double submits of the same link by the same seller.
    await tx`select pg_advisory_xact_lock(hashtext(${`${input.sellerId}|${input.openapiUrl}`}))`;
    const [existing] = await tx<Api[]>`
      select ${tx(API_COLUMNS)} from apis
      where seller_id = ${input.sellerId} and openapi_url = ${input.openapiUrl} and state <> 'retired'
      order by created_at desc limit 1`;
    if (existing) return { api: existing, created: false };
    const [api] = await tx<Api[]>`
      insert into apis (id, seller_id, name, origin, openapi_url)
      values (${newId("api")}, ${input.sellerId}, ${input.name}, ${input.origin}, ${input.openapiUrl})
      returning ${tx(API_COLUMNS)}`;
    return { api, created: true };
  });
}

export async function getApiForSeller(sql: Sql, apiId: string, sellerId: string): Promise<Api | null> {
  const [row] = await sql<Api[]>`select ${sql(API_COLUMNS)} from apis where id = ${apiId} and seller_id = ${sellerId}`;
  return row ?? null;
}

export async function getLiveApi(sql: Sql, apiId: string): Promise<Api | null> {
  const [row] = await sql<Api[]>`select ${sql(API_COLUMNS)} from apis where id = ${apiId} and state = 'live'`;
  return row ?? null;
}

export async function listApisForSeller(sql: Sql, sellerId: string): Promise<Api[]> {
  return sql<Api[]>`select ${sql(API_COLUMNS)} from apis where seller_id = ${sellerId} order by created_at desc`;
}

/** Conditional transition: succeeds only from one of `from`, so double clicks and races can't skip a step. */
export async function transitionState(
  sql: Sql,
  a: { apiId: string; sellerId: string; from: ApiState[]; to: ApiState },
): Promise<boolean> {
  const rows = await sql`
    update apis set state = ${a.to}
    where id = ${a.apiId} and seller_id = ${a.sellerId} and state in ${sql(a.from)}
    returning id`;
  return rows.length === 1;
}

export async function listOnboardSteps(sql: Sql, apiId: string): Promise<OnboardStep[]> {
  return sql<OnboardStep[]>`
    select step, status, output, updated_at from onboard_steps where api_id = ${apiId} order by updated_at asc`;
}
```

`apps/web/lib/validate.ts`:
```ts
export class ValidationError extends Error {}

export function validateOpenApiUrl(raw: unknown, allowInsecure: boolean): { url: string; origin: string; hostname: string } {
  if (typeof raw !== "string" || raw.trim() === "") throw new ValidationError("Paste the link to your OpenAPI description.");
  const s = raw.trim();
  if (s.length > 2048) throw new ValidationError("That link is too long.");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ValidationError("That doesn't look like a web link. It should start with https://");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(allowInsecure && u.protocol === "http:" && local)) {
    throw new ValidationError("The link must start with https://");
  }
  if (u.username || u.password) {
    throw new ValidationError("Remove the username and password from the link. Hirakumi only supports public API descriptions.");
  }
  u.hash = "";
  return { url: u.toString(), origin: u.origin, hostname: u.hostname };
}

export function validateApiName(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return fallback.slice(0, 80);
  if (typeof raw !== "string") throw new ValidationError("The name must be text.");
  const s = raw.trim();
  if (s.length > 80) throw new ValidationError("Keep the name under 80 characters.");
  return s;
}
```

`apps/web/lib/route-helpers.ts`:
```ts
import { STATE_LABEL } from "./copy";
import { getSql, type Sql } from "./db";
import { errorJson, requireSeller, type ApiRouteContext } from "./http";
import { getApiForSeller } from "./repo/apis";
import type { SessionInfo } from "./session";
import type { Api } from "./types";

/** Every /api/apis/[apiId]/* handler starts here: signed in, and the API belongs to this seller. */
export async function loadOwnedApi(
  req: Request,
  ctx: ApiRouteContext,
): Promise<{ session: SessionInfo; api: Api; sql: Sql } | Response> {
  const session = requireSeller(req);
  if (session instanceof Response) return session;
  const { apiId } = await ctx.params;
  const sql = getSql();
  const api = await getApiForSeller(sql, apiId, session.sellerId);
  if (!api) return errorJson(404, "We couldn't find that API in your account.");
  return { session, api, sql };
}

export function wrongStep(api: Api): Response {
  return errorJson(409, `This step isn't available right now. Your API is at: ${STATE_LABEL[api.state]}. Reload the page.`);
}
```

`apps/web/lib/page-auth.ts`:
```ts
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSql } from "./db";
import { getApiForSeller } from "./repo/apis";
import { readSessionToken, SESSION_COOKIE, type SessionInfo } from "./session";
import type { Api } from "./types";

export async function requireSellerPage(nextPath: string): Promise<SessionInfo> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? readSessionToken(token) : null;
  if (!session) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return session;
}

export async function loadApiPage(apiId: string, nextPath: string): Promise<{ session: SessionInfo; api: Api }> {
  const session = await requireSellerPage(nextPath);
  const api = await getApiForSeller(getSql(), apiId, session.sellerId);
  if (!api) notFound();
  return { session, api };
}
```

`apps/web/app/api/apis/route.ts`:
```ts
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { errorJson, json, readJson, requireSeller } from "@/lib/http";
import { createApi } from "@/lib/repo/apis";
import { validateApiName, validateOpenApiUrl, ValidationError } from "@/lib/validate";

export async function POST(req: Request): Promise<Response> {
  const session = requireSeller(req);
  if (session instanceof Response) return session;
  const body = await readJson(req);
  if (!body) return errorJson(400, "Paste the link to your OpenAPI description.");
  try {
    const { url, origin, hostname } = validateOpenApiUrl(body.openapiUrl, env.allowInsecureUpstream());
    const name = validateApiName(body.name, hostname);
    const { api, created } = await createApi(getSql(), { sellerId: session.sellerId, name, origin, openapiUrl: url });
    return json({ apiId: api.id, state: api.state, created }, created ? 201 : 200);
  } catch (e) {
    if (e instanceof ValidationError) return errorJson(400, e.message);
    throw e;
  }
}
```

- [ ] **Step 4: Write the shared components and Setup form**

`apps/web/components/auto-refresh.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-runs the server component every `everyMs` so waiting screens update by themselves. */
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
```

`apps/web/components/states.tsx`:
```tsx
import type { ReactNode } from "react";
import { AutoRefresh } from "./auto-refresh";

export function WaitingState({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div role="status" className="space-y-2 rounded-lg border p-6">
      <AutoRefresh everyMs={2000} />
      <p className="font-medium">{title}</p>
      {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
      {children}
    </div>
  );
}

export function ErrorState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-destructive/50 p-6">
      <p className="font-medium">{title}</p>
      <p className="text-sm">{detail}</p>
      {action}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-6 text-center">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{detail}</p>
      {action}
    </div>
  );
}
```

`apps/web/components/step-list.tsx`:
```tsx
import { humanizeStep, STEP_STATUS_LABEL } from "@/lib/copy";
import type { OnboardStep } from "@/lib/types";

export function StepList({ steps }: { steps: OnboardStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm">
      {steps.map((s) => (
        <li key={s.step} className="flex justify-between gap-4">
          <span>{humanizeStep(s.step)}</span>
          <span className="text-muted-foreground">{STEP_STATUS_LABEL[s.status]}</span>
        </li>
      ))}
    </ul>
  );
}
```

`apps/web/components/health-badge.tsx`:
```tsx
import { Badge } from "@/components/ui/badge";
import { healthLabel, STATE_LABEL } from "@/lib/copy";
import { isStale } from "@/lib/flow";
import type { ApiState, Health } from "@/lib/types";

export function HealthBadge({ state, health, checkedAt, now }: {
  state: ApiState;
  health: Health;
  checkedAt: Date | string | null;
  now?: Date;
}) {
  if (state !== "live") return <Badge variant="secondary">{STATE_LABEL[state]}</Badge>;
  const checked = checkedAt ? new Date(checkedAt) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge variant={health === "healthy" ? "default" : "destructive"}>{healthLabel(health)}</Badge>
      {isStale(checked, now) && (
        <span role="note" className="text-xs text-amber-700">
          {checked
            ? "The last health check was more than 10 minutes ago. The monitor may have stopped."
            : "Not checked yet."}
        </span>
      )}
    </span>
  );
}
```

`apps/web/components/api-nav.tsx`:
```tsx
import Link from "next/link";

export function ApiNav({ apiId }: { apiId: string }) {
  const links = [
    { href: `/apis/${apiId}`, label: "Listing steps" },
    { href: `/apis/${apiId}/overview`, label: "Overview" },
    { href: `/apis/${apiId}/sales`, label: "Sales" },
  ];
  return (
    <nav className="flex gap-4 border-b pb-2 text-sm">
      <Link href="/apis" className="text-muted-foreground">All APIs</Link>
      {links.map((l) => (
        <Link key={l.href} href={l.href}>{l.label}</Link>
      ))}
    </nav>
  );
}
```

`apps/web/components/setup-form.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson, RequestError } from "@/lib/client-fetch";

export function SetupForm({ initialUrl }: { initialUrl: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await postJson<{ apiId: string }>("/api/apis", { openapiUrl: url, name });
      router.push(`/apis/${data.apiId}/endpoints`);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="openapi-url" className="text-sm font-medium">OpenAPI link</label>
        <Input id="openapi-url" type="text" inputMode="url" placeholder="https://example.com/openapi.json"
          value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="space-y-2">
        <label htmlFor="api-name" className="text-sm font-medium">Name (optional)</label>
        <Input id="api-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Continue"}</Button>
    </form>
  );
}
```

- [ ] **Step 5: Write the pages**

`apps/web/app/apis/page.tsx`:
```tsx
import Link from "next/link";
import { HealthBadge } from "@/components/health-badge";
import { EmptyState } from "@/components/states";
import { shortAddress } from "@/lib/copy";
import { getSql } from "@/lib/db";
import { requireSellerPage } from "@/lib/page-auth";
import { listApisForSeller } from "@/lib/repo/apis";

export default async function ApisPage() {
  const session = await requireSellerPage("/apis");
  const apis = await listApisForSeller(getSql(), session.sellerId);
  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your APIs</h1>
        <Link href="/apis/new" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Add an API</Link>
      </div>
      <p className="text-sm text-muted-foreground">Signed in as {shortAddress(session.addr)}. Buyers pay this address.</p>
      {apis.length === 0 ? (
        <EmptyState title="You haven't listed an API yet." detail="Add your first API with a link to its OpenAPI description." />
      ) : (
        <ul className="divide-y rounded-lg border">
          {apis.map((a) => (
            <li key={a.id} className="flex items-center justify-between p-4">
              <Link href={`/apis/${a.id}`} className="font-medium">{a.name}</Link>
              <HealthBadge state={a.state} health={a.health} checkedAt={a.healthCheckedAt} />
            </li>
          ))}
        </ul>
      )}
      <form action="/api/auth/logout" method="post">
        <button type="submit" className="text-sm underline">Sign out</button>
      </form>
    </section>
  );
}
```

`apps/web/app/apis/new/page.tsx`:
```tsx
import { SetupForm } from "@/components/setup-form";
import { requireSellerPage } from "@/lib/page-auth";

export default async function NewApiPage({ searchParams }: { searchParams: Promise<{ openapiUrl?: string }> }) {
  await requireSellerPage("/apis/new");
  const { openapiUrl } = await searchParams;
  return (
    <section className="max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold">Put your API on the agent market</h1>
      <p className="text-muted-foreground">
        Paste the link to your OpenAPI 3 description. Hirakumi reads it and lists the endpoints it could sell.
        Nothing is published until you approve it.
      </p>
      <SetupForm initialUrl={typeof openapiUrl === "string" ? openapiUrl : ""} />
    </section>
  );
}
```

`apps/web/app/apis/[apiId]/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";

export default async function ApiStepRouter({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}`);
  redirect(`/apis/${apiId}/${stepForState(api.state)}`);
}
```

`apps/web/app/apis/[apiId]/layout.tsx`:
```tsx
import type { ReactNode } from "react";
import { ApiNav } from "@/components/api-nav";

export default async function ApiLayout({ children, params }: { children: ReactNode; params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  return (
    <div className="space-y-6">
      <ApiNav apiId={apiId} />
      {children}
    </div>
  );
}
```

- [ ] **Step 6: Run the tests (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/validate.test.ts app/api/apis/apis.test.ts components/setup-form.test.tsx components/health-badge.test.tsx`
Expected: PASS (all tests in 4 files).

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): Setup screen creates the API in intake; API list, step router and state components" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Local stand-ins for the coworker and the gateway (dev and test only)

These scripts let P2 reach the hour-10 checkpoint before P1 and P3 land. They write coworker-owned tables, so `dev-coworker` refuses any database that isn't on `localhost`.

**Files:**
- Create: `apps/web/scripts/dev-coworker.ts`, `apps/web/scripts/mock-gateway.ts`
- Test: `apps/web/scripts/dev-coworker.test.ts`

**Interfaces:**
- Consumes: `newId`, `ruleHash`, `RuleDefinition` (`@hirakumi/core`); contract tables `operations`, `rules`, `onboard_steps`, `apis`.
- Produces:
  - `DEMO_OPERATIONS`; `demoRule(apiId: string, opId: string): RuleDefinition`; `DEMO_PROMISE: string`
  - `fakeParse(sql, apiId): Promise<void>` (intake|parsed → described, 3 operations); `fakeBuildRules(sql, apiId): Promise<void>` (ownership_verified → rule_built, one rule per enabled op); `fakeGoLive(sql, apiId): Promise<void>` (registering → live); `fakeFail(sql, apiId, step, error): Promise<void>`
  - CLI: `pnpm --filter @hirakumi/web dev:coworker <parse|build-rules|go-live|fail> <apiId> [step] [message]`
  - `startMockGateway(port: number, token: string, opts?: { challengeOk?: boolean }): Promise<Server>`; CLI `pnpm --filter @hirakumi/web dev:gateway` (port `MOCK_GATEWAY_PORT` or 4999, token `INTERNAL_TOKEN`, `MOCK_CHALLENGE=fail` to simulate a missing file)

- [ ] **Step 1: Write the failing test**

`apps/web/scripts/dev-coworker.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { fakeBuildRules, fakeGoLive, fakeParse } from "./dev-coworker";

describe("dev coworker", () => {
  beforeEach(resetDb);

  it("parses: intake -> described with three blocked operations", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "intake");
    await fakeParse(getSql(), api.id);
    const ops = await getSql()<{ opId: string; enabled: boolean }[]>`select op_id, enabled from operations where api_id = ${api.id} order by op_id`;
    expect(ops.map((o) => o.opId)).toEqual(["getHistory", "getPrice", "refreshCache"]);
    expect(ops.every((o) => !o.enabled)).toBe(true);
    const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
    expect(row.state).toBe("described");
  });

  it("builds one promise per enabled operation and moves to rule_built", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "intake");
    await fakeParse(getSql(), api.id);
    await getSql()`update operations set enabled = true where api_id = ${api.id} and op_id = 'getPrice'`;
    await getSql()`update apis set state = 'ownership_verified' where id = ${api.id}`;
    await fakeBuildRules(getSql(), api.id);
    const [{ count }] = await getSql()<{ count: number }[]>`
      select count(*)::int as count from rules r join operations o on o.id = r.operation_id where o.api_id = ${api.id}`;
    expect(count).toBe(1);
    const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
    expect(row.state).toBe("rule_built");
  });

  it("refuses to run from the wrong state", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "priced");
    await expect(fakeParse(getSql(), api.id)).rejects.toThrow("fakeParse needs state intake or parsed, got priced");
    await expect(fakeGoLive(getSql(), api.id)).rejects.toThrow("fakeGoLive needs state registering");
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run scripts/dev-coworker.test.ts`
Expected: FAIL, `Failed to resolve import "./dev-coworker"`.

- [ ] **Step 3: Write the scripts**

`apps/web/scripts/dev-coworker.ts`:
```ts
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { newId, ruleHash, type RuleDefinition } from "@hirakumi/core";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

type DemoOperation = {
  opId: string;
  method: string;
  path: string;
  description: string;
  sideEffectsLikely: boolean;
  inputSchema: Record<string, unknown>;
};

export const DEMO_OPERATIONS: DemoOperation[] = [
  { opId: "getPrice", method: "GET", path: "/price", description: "Returns the latest price for a symbol such as ADA.",
    sideEffectsLikely: false, inputSchema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" } } } },
  { opId: "getHistory", method: "GET", path: "/history", description: "Returns daily prices for a symbol.",
    sideEffectsLikely: false, inputSchema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" }, days: { type: "integer" } } } },
  { opId: "refreshCache", method: "POST", path: "/admin/refresh", description: "Clears and rebuilds the server cache.",
    sideEffectsLikely: true, inputSchema: { type: "object" } },
];

export const DEMO_PROMISE =
  'The response is JSON with a "symbol", a number "price", and a "last_updated" time no more than 5 minutes old.';

export function demoRule(apiId: string, opId: string): RuleDefinition {
  return {
    version: 1,
    status: { min: 200, max: 299 },
    contentType: "application/json",
    schema: {
      title: `${apiId}/${opId}`, // keeps rules.hash unique across APIs (contract note A7)
      type: "object",
      required: ["symbol", "price", "last_updated"],
      properties: { symbol: { type: "string" }, price: { type: "number" }, last_updated: { type: "string", maxAgeSeconds: 300 } },
    },
  };
}

async function setStep(tx: Tx, apiId: string, step: string, status: string, output: unknown = null): Promise<void> {
  await tx`
    insert into onboard_steps (api_id, step, status, attempts, output, updated_at)
    values (${apiId}, ${step}, ${status}, 1, ${JSON.stringify(output)}::jsonb, now())
    on conflict (api_id, step) do update
      set status = excluded.status, attempts = onboard_steps.attempts + 1, output = excluded.output, updated_at = now()`;
}

async function lockState(tx: Tx, apiId: string): Promise<string | null> {
  const [row] = await tx<{ state: string }[]>`select state from apis where id = ${apiId} for update`;
  return row?.state ?? null;
}

export async function fakeParse(sql: Sql, apiId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const state = await lockState(tx, apiId);
    if (state !== "intake" && state !== "parsed") throw new Error(`fakeParse needs state intake or parsed, got ${state ?? "missing"}`);
    for (const op of DEMO_OPERATIONS) {
      await tx`
        insert into operations (id, api_id, op_id, method, path, input_schema, description, side_effects_likely)
        values (${newId("op")}, ${apiId}, ${op.opId}, ${op.method}, ${op.path}, ${JSON.stringify(op.inputSchema)}::jsonb,
                ${op.description}, ${op.sideEffectsLikely})
        on conflict (api_id, op_id) do nothing`;
    }
    await setStep(tx, apiId, "parse", "done", { operations: DEMO_OPERATIONS.length });
    await setStep(tx, apiId, "describe", "done");
    await tx`update apis set state = 'described' where id = ${apiId}`;
  });
}

export async function fakeBuildRules(sql: Sql, apiId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const state = await lockState(tx, apiId);
    if (state !== "ownership_verified") throw new Error(`fakeBuildRules needs state ownership_verified, got ${state ?? "missing"}`);
    const ops = await tx<{ id: string; opId: string }[]>`
      select id, op_id as "opId" from operations where api_id = ${apiId} and enabled`;
    if (ops.length === 0) throw new Error("fakeBuildRules found no enabled operations");
    for (const op of ops) {
      const def = demoRule(apiId, op.opId);
      await tx`
        insert into rules (id, operation_id, version, definition, hash, plain_english)
        values (${newId("rule")}, ${op.id}, 1, ${JSON.stringify(def)}::jsonb, ${ruleHash(def)}, ${DEMO_PROMISE})
        on conflict (operation_id, version) do nothing`;
    }
    await setStep(tx, apiId, "qa", "done", { testCalls: 5 });
    await tx`update apis set state = 'rule_built' where id = ${apiId}`;
  });
}

export async function fakeGoLive(sql: Sql, apiId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const state = await lockState(tx, apiId);
    if (state !== "registering") throw new Error(`fakeGoLive needs state registering, got ${state ?? "missing"}`);
    await tx`
      update apis set state = 'live', agent_identifier = coalesce(agent_identifier, ${`demo_${apiId}`}),
        health = 'healthy', health_checked_at = now()
      where id = ${apiId}`;
    await setStep(tx, apiId, "register", "done");
  });
}

export async function fakeFail(sql: Sql, apiId: string, step: string, error: string): Promise<void> {
  await sql.begin(async (tx) => {
    await setStep(tx, apiId, step, "failed", { error });
  });
}

async function main(): Promise<void> {
  const [cmd, apiId, ...rest] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`dev-coworker only runs against a local database, not ${host}`);
  if (!cmd || !apiId) {
    console.error("usage: dev-coworker <parse|build-rules|go-live|fail> <apiId> [step] [message]");
    process.exit(2);
  }
  const sql = postgres(url, { max: 1 });
  try {
    if (cmd === "parse") await fakeParse(sql, apiId);
    else if (cmd === "build-rules") await fakeBuildRules(sql, apiId);
    else if (cmd === "go-live") await fakeGoLive(sql, apiId);
    else if (cmd === "fail") {
      await fakeFail(sql, apiId, rest[0] ?? "parse",
        rest.slice(1).join(" ") || "This looks like Swagger 2.0. Hirakumi needs an OpenAPI 3.x description.");
    } else throw new Error(`unknown command ${cmd}`);
    console.log(`${cmd} done for ${apiId}`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
```

`apps/web/scripts/mock-gateway.ts`:
```ts
import { createServer, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

/** Answers the gateway's /internal/* routes the way the contract describes them. Dev and tests only. */
export function startMockGateway(port: number, token: string, opts: { challengeOk?: boolean } = {}): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
    const url = req.url ?? "";
    const check = url.match(/^\/internal\/challenge\/([^/]+)\/check$/);
    if (req.method === "POST" && check) {
      const ok = opts.challengeOk ?? process.env.MOCK_CHALLENGE !== "fail";
      const triedUrl = `https://price.example.dev/.well-known/hirakumi/${check[1]}.txt`;
      return send(res, 200, ok
        ? { ok: true, triedUrl, detail: "The file matched." }
        : { ok: false, triedUrl, detail: "Got HTTP 404 Not Found." });
    }
    if (req.method === "POST" && /^\/internal\/apis\/[^/]+\/reload$/.test(url)) return send(res, 204);
    if (req.method === "GET" && /^\/internal\/apis\/[^/]+\/health$/.test(url)) {
      return send(res, 200, { health: "healthy", checkedAt: new Date().toISOString(), lastReasons: [] });
    }
    return send(res, 404, { error: "not found" });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_GATEWAY_PORT ?? 4999);
  const token = process.env.INTERNAL_TOKEN ?? "change-me-32-bytes";
  startMockGateway(port, token).then(() => console.log(`mock gateway on http://127.0.0.1:${port}`));
}
```

- [ ] **Step 4: Run the test (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run scripts/dev-coworker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/scripts
git commit -m "chore(web): local coworker and gateway stand-ins for dev and tests" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Endpoints screen (tick, confirm no side effects, choose the escrow operation)

**Files:**
- Create: `apps/web/lib/repo/operations.ts`, `apps/web/app/api/apis/[apiId]/endpoints/route.ts`, `apps/web/components/endpoints-form.tsx`, `apps/web/app/apis/[apiId]/endpoints/page.tsx`
- Test: `apps/web/app/api/apis/[apiId]/endpoints/endpoints.test.ts`, `apps/web/components/endpoints-form.test.tsx`

**Interfaces:**
- Consumes: `loadOwnedApi` (Task 7); `validateEndpointSelection`, `parseSelection`, `needsNoSideEffectConfirmation`, `EndpointSelection` (Task 3); `listOnboardSteps` (Task 7); `firstFailedStep`, `stepForState` (Task 3); `WaitingState`, `ErrorState`, `EmptyState`, `StepList` (Task 7); `postJson`, `RequestError` (Task 6).
- Produces:
  - `OPERATION_COLUMNS`; `listOperations(sql, apiId): Promise<Operation[]>`; `confirmEndpoints(sql, { apiId, sellerId, selection }): Promise<RepoResult>`
  - `POST /api/apis/:apiId/endpoints` body `EndpointSelection` → 200 `{ state: "endpoints_confirmed" }` | 400/401/404/409 `{ error }`. Writes `operations.enabled`, `operations.side_effects_confirmed_none`, `apis.escrow_op_id` (= OpenAPI `op_id`, contract addition A3), `apis.state`.
  - `<EndpointsForm apiId operations initialEscrowOpId />`

- [ ] **Step 1: Write the failing route test**

`apps/web/app/api/apis/[apiId]/endpoints/endpoints.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST } from "./route";

async function setup(state: Parameters<typeof seedApi>[1] = "described") {
  const seller = await seedSeller();
  const api = await seedApi(seller.id, state);
  const get = await seedOperation(api.id, { opId: "getPrice", method: "GET", path: "/price" });
  const post = await seedOperation(api.id, { opId: "refreshCache", method: "POST", path: "/admin/refresh", sideEffectsLikely: true });
  return { seller, api, get, post };
}

function send(cookie: string, apiId: string, body: unknown) {
  return POST(jsonRequest(`/api/apis/${apiId}/endpoints`, { cookie, body }), ctx(apiId));
}

describe("POST /api/apis/:apiId/endpoints", () => {
  beforeEach(resetDb);

  it("saves the choice and moves to endpoints_confirmed", async () => {
    const { seller, api, get, post } = await setup();
    const res = await send(cookieFor(seller), api.id, {
      enabledIds: [get.id], confirmedNoSideEffectIds: [], escrowOperationId: get.id,
    });
    expect(res.status).toBe(200);
    const ops = await getSql()<{ id: string; enabled: boolean }[]>`select id, enabled from operations where api_id = ${api.id}`;
    expect(Object.fromEntries(ops.map((o) => [o.id, o.enabled]))).toEqual({ [get.id]: true, [post.id]: false });
    const [row] = await getSql()<{ state: string; escrowOpId: string }[]>`select state, escrow_op_id from apis where id = ${api.id}`;
    expect(row).toEqual({ state: "endpoints_confirmed", escrowOpId: "getPrice" });
  });

  it("records the no-side-effects confirmation for a POST endpoint", async () => {
    const { seller, api, post } = await setup();
    const res = await send(cookieFor(seller), api.id, {
      enabledIds: [post.id], confirmedNoSideEffectIds: [post.id], escrowOperationId: post.id,
    });
    expect(res.status).toBe(200);
    const [row] = await getSql()<{ sideEffectsConfirmedNone: boolean }[]>`
      select side_effects_confirmed_none from operations where id = ${post.id}`;
    expect(row.sideEffectsConfirmedNone).toBe(true);
  });

  it("refuses a POST endpoint without the confirmation", async () => {
    const { seller, api, post } = await setup();
    const res = await send(cookieFor(seller), api.id, { enabledIds: [post.id], confirmedNoSideEffectIds: [], escrowOperationId: post.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Confirm that POST /admin/refresh changes nothing on your server, or don't sell it." });
  });

  it("can be changed again before ownership is proved", async () => {
    const { seller, api, get } = await setup("endpoints_confirmed");
    const res = await send(cookieFor(seller), api.id, { enabledIds: [get.id], confirmedNoSideEffectIds: [], escrowOperationId: get.id });
    expect(res.status).toBe(200);
  });

  it("refuses once ownership is verified", async () => {
    const { seller, api, get } = await setup("ownership_verified");
    const res = await send(cookieFor(seller), api.id, { enabledIds: [get.id], confirmedNoSideEffectIds: [], escrowOperationId: get.id });
    expect(res.status).toBe(409);
  });

  it("returns 404 for another seller's API", async () => {
    const { api, get } = await setup();
    const intruder = await seedSeller();
    const res = await send(cookieFor(intruder), api.id, { enabledIds: [get.id], confirmedNoSideEffectIds: [], escrowOperationId: get.id });
    expect(res.status).toBe(404);
    const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
    expect(row.state).toBe("described");
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run "app/api/apis/[apiId]/endpoints/endpoints.test.ts"`
Expected: FAIL, `Failed to resolve import "./route"`.

- [ ] **Step 3: Write the repo and route**

`apps/web/lib/repo/operations.ts`:
```ts
import type { Sql } from "../db";
import { validateEndpointSelection, type EndpointSelection } from "../endpoints";
import type { ApiState, Operation, RepoResult } from "../types";

export const OPERATION_COLUMNS = [
  "id", "op_id", "method", "path", "description", "side_effects_likely", "side_effects_confirmed_none", "enabled",
];

export async function listOperations(sql: Sql, apiId: string): Promise<Operation[]> {
  return sql<Operation[]>`select ${sql(OPERATION_COLUMNS)} from operations where api_id = ${apiId} order by path, method`;
}

export async function confirmEndpoints(
  sql: Sql,
  a: { apiId: string; sellerId: string; selection: EndpointSelection },
): Promise<RepoResult> {
  return sql.begin(async (tx): Promise<RepoResult> => {
    const [api] = await tx<{ state: ApiState }[]>`
      select state from apis where id = ${a.apiId} and seller_id = ${a.sellerId} for update`;
    if (!api) return { ok: false, status: 404, error: "We couldn't find that API in your account." };
    if (api.state !== "described" && api.state !== "endpoints_confirmed") {
      return { ok: false, status: 409, error: "Endpoints can't be changed at this stage. Reload the page." };
    }
    const ops = await tx<Operation[]>`select ${tx(OPERATION_COLUMNS)} from operations where api_id = ${a.apiId}`;
    const problem = validateEndpointSelection(ops, a.selection);
    if (problem) return { ok: false, status: 400, error: problem };
    const enabled = new Set(a.selection.enabledIds);
    const confirmed = new Set(a.selection.confirmedNoSideEffectIds);
    for (const op of ops) {
      await tx`
        update operations
        set enabled = ${enabled.has(op.id)}, side_effects_confirmed_none = ${enabled.has(op.id) && confirmed.has(op.id)}
        where id = ${op.id}`;
    }
    const escrowOp = ops.find((o) => o.id === a.selection.escrowOperationId);
    await tx`update apis set escrow_op_id = ${escrowOp!.opId}, state = 'endpoints_confirmed' where id = ${a.apiId}`;
    return { ok: true };
  });
}
```

`apps/web/app/api/apis/[apiId]/endpoints/route.ts`:
```ts
import { parseSelection } from "@/lib/endpoints";
import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { confirmEndpoints } from "@/lib/repo/operations";
import { loadOwnedApi } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const body = await readJson(req);
  const selection = body ? parseSelection(body) : null;
  if (!selection) return errorJson(400, "Choose at least one endpoint to sell.");
  const result = await confirmEndpoints(loaded.sql, { apiId: loaded.api.id, sellerId: loaded.session.sellerId, selection });
  if (!result.ok) return errorJson(result.status, result.error);
  return json({ state: "endpoints_confirmed" });
}
```

- [ ] **Step 4: Run the route test (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run "app/api/apis/[apiId]/endpoints/endpoints.test.ts"`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing component test**

`apps/web/components/endpoints-form.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Operation } from "@/lib/types";
import { jsonResponse } from "@/test/http";
import { EndpointsForm } from "./endpoints-form";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const ops: Operation[] = [
  { id: "op_get", opId: "getPrice", method: "GET", path: "/price", description: "Latest price",
    sideEffectsLikely: false, sideEffectsConfirmedNone: false, enabled: false },
  { id: "op_post", opId: "refreshCache", method: "POST", path: "/admin/refresh", description: "Refreshes the cache",
    sideEffectsLikely: true, sideEffectsConfirmedNone: false, enabled: false },
];

afterEach(() => {
  vi.unstubAllGlobals();
  nav.push.mockReset();
});

describe("EndpointsForm", () => {
  it("starts with everything blocked and explains why it can't continue", () => {
    render(<EndpointsForm apiId="api_1" operations={ops} initialEscrowOpId={null} />);
    expect(screen.getByRole("button", { name: "Confirm endpoints" })).toBeDisabled();
    expect(screen.getByText("Choose at least one endpoint to sell.")).toBeInTheDocument();
    expect(screen.getByText("This might change data on your server.")).toBeInTheDocument();
  });

  it("sends the selection and opens the Ownership step", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ state: "endpoints_confirmed" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<EndpointsForm apiId="api_1" operations={ops} initialEscrowOpId={null} />);
    await user.click(screen.getByLabelText("Sell GET /price"));
    await user.click(screen.getByLabelText("Use GET /price for per-job hires"));
    await user.click(screen.getByRole("button", { name: "Confirm endpoints" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/ownership"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/apis/api_1/endpoints");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      enabledIds: ["op_get"], confirmedNoSideEffectIds: [], escrowOperationId: "op_get",
    });
  });

  it("asks for the no-side-effects tick before a POST endpoint can be sold", async () => {
    const user = userEvent.setup();
    render(<EndpointsForm apiId="api_1" operations={ops} initialEscrowOpId={null} />);
    await user.click(screen.getByLabelText("Sell POST /admin/refresh"));
    await user.click(screen.getByLabelText("Use POST /admin/refresh for per-job hires"));
    expect(screen.getByRole("button", { name: "Confirm endpoints" })).toBeDisabled();
    await user.click(screen.getByLabelText("POST /admin/refresh changes nothing on my server"));
    expect(screen.getByRole("button", { name: "Confirm endpoints" })).toBeEnabled();
  });

  it("shows the server's error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "Endpoints can't be changed at this stage. Reload the page." }, 409)));
    const user = userEvent.setup();
    render(<EndpointsForm apiId="api_1" operations={ops} initialEscrowOpId={null} />);
    await user.click(screen.getByLabelText("Sell GET /price"));
    await user.click(screen.getByLabelText("Use GET /price for per-job hires"));
    await user.click(screen.getByRole("button", { name: "Confirm endpoints" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Endpoints can't be changed at this stage.");
  });
});
```

- [ ] **Step 6: Run the component test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run components/endpoints-form.test.tsx`
Expected: FAIL, `Failed to resolve import "./endpoints-form"`.

- [ ] **Step 7: Write the component and page**

`apps/web/components/endpoints-form.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";
import { needsNoSideEffectConfirmation, validateEndpointSelection, type EndpointSelection } from "@/lib/endpoints";
import type { Operation } from "@/lib/types";

function withItem(set: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export function EndpointsForm({ apiId, operations, initialEscrowOpId }: {
  apiId: string;
  operations: Operation[];
  initialEscrowOpId: string | null;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(() => new Set(operations.filter((o) => o.enabled).map((o) => o.id)));
  const [confirmed, setConfirmed] = useState(() => new Set(operations.filter((o) => o.sideEffectsConfirmedNone).map((o) => o.id)));
  const [escrow, setEscrow] = useState<string | null>(() => operations.find((o) => o.opId === initialEscrowOpId)?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selection: EndpointSelection = {
    enabledIds: operations.filter((o) => enabled.has(o.id)).map((o) => o.id),
    confirmedNoSideEffectIds: operations.filter((o) => enabled.has(o.id) && confirmed.has(o.id)).map((o) => o.id),
    escrowOperationId: escrow,
  };
  const problem = validateEndpointSelection(operations, selection);

  function toggleEnabled(id: string, on: boolean) {
    setEnabled((prev) => withItem(prev, id, on));
    if (!on) {
      setConfirmed((prev) => withItem(prev, id, false));
      if (escrow === id) setEscrow(null);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/apis/${apiId}/endpoints`, selection);
      router.push(`/apis/${apiId}/ownership`);
    } catch (e) {
      setError(e instanceof RequestError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Every endpoint starts blocked. Tick the ones agents may buy. Only sell endpoints that read data and change nothing.
      </p>
      <ul className="divide-y rounded-lg border">
        {operations.map((op) => {
          const label = `${op.method.toUpperCase()} ${op.path}`;
          const isOn = enabled.has(op.id);
          return (
            <li key={op.id} className="space-y-2 p-4">
              <label className="flex items-center gap-3">
                <input type="checkbox" aria-label={`Sell ${label}`} checked={isOn}
                  onChange={(e) => toggleEnabled(op.id, e.target.checked)} />
                <Badge variant="outline">{op.method.toUpperCase()}</Badge>
                <code>{op.path}</code>
              </label>
              <p className="text-sm text-muted-foreground">{op.description ?? "No description yet."}</p>
              {op.sideEffectsLikely && <p className="text-sm text-amber-700">This might change data on your server.</p>}
              {isOn && needsNoSideEffectConfirmation(op) && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" aria-label={`${label} changes nothing on my server`} checked={confirmed.has(op.id)}
                    onChange={(e) => setConfirmed((prev) => withItem(prev, op.id, e.target.checked))} />
                  I confirm this endpoint changes nothing on my server.
                </label>
              )}
              {isOn && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="escrow-op" aria-label={`Use ${label} for per-job hires`} checked={escrow === op.id}
                    onChange={() => setEscrow(op.id)} />
                  Use this endpoint for per-job hires (Masumi escrow).
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {problem && <p className="text-sm text-muted-foreground">{problem}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={problem !== null || busy} onClick={submit}>{busy ? "Saving…" : "Confirm endpoints"}</Button>
    </div>
  );
}
```

`apps/web/app/apis/[apiId]/endpoints/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { EndpointsForm } from "@/components/endpoints-form";
import { EmptyState, ErrorState, WaitingState } from "@/components/states";
import { StepList } from "@/components/step-list";
import { getSql } from "@/lib/db";
import { firstFailedStep, stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { listOnboardSteps } from "@/lib/repo/apis";
import { listOperations } from "@/lib/repo/operations";

export default async function EndpointsPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/endpoints`);
  const sql = getSql();
  const heading = <h1 className="text-2xl font-semibold">Choose what to sell</h1>;

  if (api.state === "intake" || api.state === "parsed") {
    const steps = await listOnboardSteps(sql, apiId);
    const failure = firstFailedStep(steps);
    if (failure) {
      return (
        <section className="space-y-4">
          {heading}
          <ErrorState title="We couldn't read your API description" detail={failure}
            action={<a href="/apis/new" className="text-sm underline">Try another link</a>} />
        </section>
      );
    }
    return (
      <section className="space-y-4">
        {heading}
        <WaitingState title="Reading your API description" detail="This usually takes under a minute. This page updates by itself.">
          <StepList steps={steps} />
        </WaitingState>
      </section>
    );
  }
  if (api.state !== "described" && api.state !== "endpoints_confirmed") redirect(`/apis/${apiId}/${stepForState(api.state)}`);

  const operations = await listOperations(sql, apiId);
  return (
    <section className="space-y-4">
      {heading}
      {operations.length === 0 ? (
        <EmptyState title="No endpoints found"
          detail="Your OpenAPI description doesn't list any operations. Add at least one GET operation, then paste the link again."
          action={<a href="/apis/new" className="text-sm underline">Paste a new link</a>} />
      ) : (
        <EndpointsForm apiId={apiId} operations={operations} initialEscrowOpId={api.escrowOpId} />
      )}
    </section>
  );
}
```

- [ ] **Step 8: Run both tests (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run "app/api/apis/[apiId]/endpoints/endpoints.test.ts" components/endpoints-form.test.tsx`
Expected: PASS (10 tests).

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): Endpoints screen with per-endpoint side-effect confirmation and escrow choice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Gateway internal client

**Files:**
- Create: `apps/web/lib/gateway.ts`
- Test: `apps/web/lib/gateway.test.ts`

**Interfaces:**
- Consumes: contract gateway routes `POST /internal/challenge/:apiId/check`, `POST /internal/apis/:apiId/reload`, `GET /internal/apis/:apiId/health`; `env.gatewayInternalUrl()`, `env.internalToken()` (Task 2); `startMockGateway` (Task 8).
- Produces:
  - `type ChallengeCheck = { ok: boolean; triedUrl: string; detail: string }`; `type GatewayHealth = { health: "healthy" | "down"; checkedAt: string | null; lastReasons: string[] }`
  - `type Gateway = { checkChallenge(apiId): Promise<ChallengeCheck>; reloadApi(apiId): Promise<void>; getHealth(apiId): Promise<GatewayHealth> }`
  - `class GatewayError extends Error { userMessage: string }`
  - `createGateway({ baseUrl, token, fetchImpl?, timeoutMs? }): Gateway`; `getGateway(): Gateway`; `setGatewayForTests(g: Gateway | null): void`; `reloadQuietly(apiId): Promise<void>`

- [ ] **Step 1: Write the failing test**

`apps/web/lib/gateway.test.ts`:
```ts
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { startMockGateway } from "@/scripts/mock-gateway";
import { jsonResponse } from "@/test/http";
import { createGateway, GatewayError } from "./gateway";

function gatewayWith(fetchImpl: typeof fetch) {
  return createGateway({ baseUrl: "https://gw.test/", token: "tok", fetchImpl });
}

describe("gateway client", () => {
  it("calls the challenge check with the bearer token and returns the result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, triedUrl: "https://x/.well-known/hirakumi/api_1.txt", detail: "Got HTTP 404" }));
    const result = await gatewayWith(fetchImpl).checkChallenge("api_1");
    expect(result).toEqual({ ok: false, triedUrl: "https://x/.well-known/hirakumi/api_1.txt", detail: "Got HTTP 404" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.test/internal/challenge/api_1/check");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("turns a network failure or timeout into a plain-English message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await gatewayWith(fetchImpl).checkChallenge("api_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).userMessage).toBe("We couldn't reach the Hirakumi checker. Try again in a minute.");
  });

  it("explains an auth failure without leaking the token", async () => {
    const err = await gatewayWith(vi.fn(async () => new Response("", { status: 401 }))).reloadApi("api_1").catch((e: unknown) => e);
    expect((err as GatewayError).userMessage).toBe("Hirakumi's checker isn't set up correctly right now. Try again later.");
    expect((err as GatewayError).message).not.toContain("tok");
  });

  it("rejects an answer with the wrong shape", async () => {
    const err = await gatewayWith(vi.fn(async () => jsonResponse({ ok: "yes" }))).checkChallenge("api_1").catch((e: unknown) => e);
    expect((err as GatewayError).userMessage).toBe("The Hirakumi checker sent an unreadable answer. Try again in a minute.");
  });

  it("reads health", async () => {
    const health = await gatewayWith(vi.fn(async () => jsonResponse({ health: "down", checkedAt: "2026-10-06T12:00:00Z", lastReasons: ["$.price missing", 3] })))
      .getHealth("api_1");
    expect(health).toEqual({ health: "down", checkedAt: "2026-10-06T12:00:00Z", lastReasons: ["$.price missing"] });
  });

  it("works against the mock gateway over real HTTP", async () => {
    const server = await startMockGateway(0, "tok", { challengeOk: true });
    try {
      const { port } = server.address() as AddressInfo;
      const gw = createGateway({ baseUrl: `http://127.0.0.1:${port}`, token: "tok" });
      expect((await gw.checkChallenge("api_9")).ok).toBe(true);
      await expect(gw.reloadApi("api_9")).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/gateway.test.ts`
Expected: FAIL, `Failed to resolve import "./gateway"`.

- [ ] **Step 3: Write the implementation**

`apps/web/lib/gateway.ts`:
```ts
import { env } from "./env";

export type ChallengeCheck = { ok: boolean; triedUrl: string; detail: string };
export type GatewayHealth = { health: "healthy" | "down"; checkedAt: string | null; lastReasons: string[] };
export type Gateway = {
  checkChallenge(apiId: string): Promise<ChallengeCheck>;
  reloadApi(apiId: string): Promise<void>;
  getHealth(apiId: string): Promise<GatewayHealth>;
};

/** `userMessage` is safe to show the seller; `message` is for logs. */
export class GatewayError extends Error {
  constructor(readonly userMessage: string, detail: string) {
    super(detail);
    this.name = "GatewayError";
  }
}

const UNREACHABLE = "We couldn't reach the Hirakumi checker. Try again in a minute.";
const UNREADABLE = "The Hirakumi checker sent an unreadable answer. Try again in a minute.";

export function createGateway(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Gateway {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  async function call(method: "GET" | "POST", path: string): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${opts.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new GatewayError(UNREACHABLE, `gateway ${method} ${path} failed: ${String(e)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new GatewayError("Hirakumi's checker isn't set up correctly right now. Try again later.", `gateway ${path} -> ${res.status} (check INTERNAL_TOKEN)`);
    }
    if (!res.ok) throw new GatewayError("The Hirakumi checker had a problem. Try again in a minute.", `gateway ${path} -> ${res.status}`);
    return res;
  }

  async function body(res: Response, path: string): Promise<Record<string, unknown>> {
    try {
      const value: unknown = await res.json();
      if (value && typeof value === "object") return value as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new GatewayError(UNREADABLE, `gateway ${path} returned non-JSON`);
  }

  return {
    async checkChallenge(apiId) {
      const path = `/internal/challenge/${encodeURIComponent(apiId)}/check`;
      const b = await body(await call("POST", path), path);
      if (typeof b.ok !== "boolean" || typeof b.triedUrl !== "string" || typeof b.detail !== "string") {
        throw new GatewayError(UNREADABLE, `gateway ${path} returned an unexpected shape`);
      }
      return { ok: b.ok, triedUrl: b.triedUrl, detail: b.detail };
    },
    async reloadApi(apiId) {
      await call("POST", `/internal/apis/${encodeURIComponent(apiId)}/reload`);
    },
    async getHealth(apiId) {
      const path = `/internal/apis/${encodeURIComponent(apiId)}/health`;
      const b = await body(await call("GET", path), path);
      if (b.health !== "healthy" && b.health !== "down") throw new GatewayError(UNREADABLE, `gateway ${path} bad health`);
      return {
        health: b.health,
        checkedAt: typeof b.checkedAt === "string" ? b.checkedAt : null,
        lastReasons: Array.isArray(b.lastReasons) ? b.lastReasons.filter((r): r is string => typeof r === "string") : [],
      };
    },
  };
}

let override: Gateway | null = null;

export function setGatewayForTests(g: Gateway | null): void {
  override = g;
}

export function getGateway(): Gateway {
  return override ?? createGateway({ baseUrl: env.gatewayInternalUrl(), token: env.internalToken() });
}

/** Cache invalidation after a seller change; failure must never block the seller's click. */
export async function reloadQuietly(apiId: string): Promise<void> {
  try {
    await getGateway().reloadApi(apiId);
  } catch (e) {
    console.warn(`gateway reload failed for ${apiId}`, e);
  }
}
```

- [ ] **Step 4: Run the test (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/gateway.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/gateway.ts apps/web/lib/gateway.test.ts
git commit -m "feat(web): typed client for the gateway's internal routes with plain-English errors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Ownership screen (challenge file, Check, wallet signature)

**Files:**
- Create: `apps/web/lib/repo/challenges.ts`, `apps/web/app/api/apis/[apiId]/challenge-file/route.ts`, `apps/web/app/api/apis/[apiId]/ownership/http-check/route.ts`, `apps/web/app/api/apis/[apiId]/ownership/wallet-challenge/route.ts`, `apps/web/app/api/apis/[apiId]/ownership/verify/route.ts`, `apps/web/components/ownership-panel.tsx`, `apps/web/app/apis/[apiId]/ownership/page.tsx`
- Test: `apps/web/app/api/apis/[apiId]/ownership/ownership.test.ts`, `apps/web/components/ownership-panel.test.tsx`

**Interfaces:**
- Consumes: `buildWalletChallenge(f: WalletChallengeFields): string`, `httpChallengePath(apiId): string`, `newId` (`@hirakumi/core`); `getGateway`, `GatewayError`, `ChallengeCheck` (Task 10); `toPreprodBech32`, `AddressError`, `verifyCip30Signature` (Task 5); `loadOwnedApi`, `wrongStep` (Task 7); `connectWallet`, `listWallets`, `signText`, `walletErrorMessage` (Task 6); `postJson` (Task 6); `shortAddress` (Task 3).
- Produces:
  - `HTTP_CHALLENGE_TTL_MINUTES = 30`; `type HttpChallenge = { id: string; token: string; expiresAt: Date; passedAt: string | null }`
  - `getOrCreateHttpChallenge(sql, apiId): Promise<HttpChallenge>`; `findCurrentHttpChallenge(sql, apiId): Promise<HttpChallenge | null>`; `markHttpPassed(sql, challengeId, triedUrl): Promise<void>`; `hasPassedHttpChallenge(sql, apiId): Promise<boolean>`
  - `createWalletChallenge(sql, { apiId, nonce, expiresAt, message }): Promise<string>`; `getOpenWalletChallenge(sql, challengeId, apiId): Promise<{ id: string; message: string } | null>`; `finalizeOwnership(sql, { apiId, walletChallengeId, signature, key }): Promise<boolean>`
  - `GET /api/apis/:apiId/challenge-file` → 200 `text/plain` attachment `<apiId>.txt` | 409
  - `POST /api/apis/:apiId/ownership/http-check` → 200 `ChallengeCheck` | 409 (no file yet) | 502 `{ error }` (gateway down)
  - `POST /api/apis/:apiId/ownership/wallet-challenge` → 200 `{ challengeId, message }` | 409
  - `POST /api/apis/:apiId/ownership/verify` body `{ challengeId, signature, key, address? }` → 200 `{ state: "ownership_verified" }` | 400/401/409
  - `<OwnershipPanel apiId fileUrl initiallyPassed />`

- [ ] **Step 1: Write the failing route test**

`apps/web/app/api/apis/[apiId]/ownership/ownership.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { GatewayError, setGatewayForTests, type Gateway } from "@/lib/gateway";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { makeTestWallet, type TestWallet } from "@/test/wallet-fixture";
import { GET as challengeFile } from "../challenge-file/route";
import { POST as httpCheck } from "./http-check/route";
import { POST as verify } from "./verify/route";
import { POST as walletChallenge } from "./wallet-challenge/route";

function fakeGateway(check: Gateway["checkChallenge"]): Gateway {
  return { checkChallenge: check, reloadApi: vi.fn(async () => undefined), getHealth: vi.fn() };
}

let wallet: TestWallet;
let seller: Seller;
let api: Api;
let cookie: string;

async function passFileCheck() {
  setGatewayForTests(fakeGateway(async (id) => ({ ok: true, triedUrl: `https://price.example.dev/.well-known/hirakumi/${id}.txt`, detail: "The file matched." })));
  await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie }), ctx(api.id));
  const res = await httpCheck(jsonRequest(`/api/apis/${api.id}/ownership/http-check`, { cookie, body: {} }), ctx(api.id));
  expect(res.status).toBe(200);
}

async function getWalletMessage() {
  const res = await walletChallenge(jsonRequest(`/api/apis/${api.id}/ownership/wallet-challenge`, { cookie, body: {} }), ctx(api.id));
  return { res, body: (await res.json()) as { challengeId: string; message: string; error?: string } };
}

function sendVerify(body: Record<string, unknown>, asCookie = cookie) {
  return verify(jsonRequest(`/api/apis/${api.id}/ownership/verify`, { cookie: asCookie, body }), ctx(api.id));
}

async function apiState() {
  const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
  return row.state;
}

describe("ownership", () => {
  beforeEach(async () => {
    await resetDb();
    wallet = await makeTestWallet();
    seller = await seedSeller(wallet.bech32);
    api = await seedApi(seller.id, "endpoints_confirmed");
    cookie = cookieFor(seller);
  });
  afterEach(() => setGatewayForTests(null));

  it("serves the same challenge file on every download", async () => {
    const a = await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie }), ctx(api.id));
    const b = await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie }), ctx(api.id));
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(a.headers.get("content-disposition")).toBe(`attachment; filename="${api.id}.txt"`);
    const text = await a.text();
    expect(text).toMatch(new RegExp(`^hirakumi-verification=${api.id}\\.`));
    expect(await b.text()).toBe(text);
  });

  it("asks for the file before checking", async () => {
    setGatewayForTests(fakeGateway(async () => ({ ok: true, triedUrl: "x", detail: "y" })));
    const res = await httpCheck(jsonRequest(`/api/apis/${api.id}/ownership/http-check`, { cookie, body: {} }), ctx(api.id));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Download the verification file first/);
  });

  it("passes the gateway's failure through with the URL tried", async () => {
    setGatewayForTests(fakeGateway(async () => ({ ok: false, triedUrl: "https://price.example.dev/.well-known/hirakumi/x.txt", detail: "Got HTTP 404 Not Found." })));
    await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie }), ctx(api.id));
    const res = await httpCheck(jsonRequest(`/api/apis/${api.id}/ownership/http-check`, { cookie, body: {} }), ctx(api.id));
    expect(await res.json()).toEqual({ ok: false, triedUrl: "https://price.example.dev/.well-known/hirakumi/x.txt", detail: "Got HTTP 404 Not Found." });
    expect((await getWalletMessage()).res.status).toBe(409);
  });

  it("answers 502 in plain English when the gateway is unreachable", async () => {
    setGatewayForTests(fakeGateway(async () => {
      throw new GatewayError("We couldn't reach the Hirakumi checker. Try again in a minute.", "ECONNREFUSED");
    }));
    await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie }), ctx(api.id));
    const res = await httpCheck(jsonRequest(`/api/apis/${api.id}/ownership/http-check`, { cookie, body: {} }), ctx(api.id));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "We couldn't reach the Hirakumi checker. Try again in a minute." });
  });

  it("refuses to issue a wallet message before the file check passed", async () => {
    const { res, body } = await getWalletMessage();
    expect(res.status).toBe(409);
    expect(body.error).toBe("Check your verification file first.");
  });

  it("verifies the owner's signature and moves to ownership_verified", async () => {
    await passFileCheck();
    const { body } = await getWalletMessage();
    expect(body.message).toContain(api.id);
    expect(body.message).toContain(wallet.bech32);
    expect(body.message).toContain("https://price.example.dev");
    const res = await sendVerify({ challengeId: body.challengeId, address: wallet.addressHex, ...wallet.sign(body.message) });
    expect(res.status).toBe(200);
    expect(await apiState()).toBe("ownership_verified");
    const open = await getSql()<{ kind: string }[]>`
      select kind from challenges where api_id = ${api.id} and consumed_at is null`;
    expect(open).toEqual([]);
  });

  it("rejects a signature from a different wallet", async () => {
    await passFileCheck();
    const { body } = await getWalletMessage();
    const other = await makeTestWallet();
    const res = await sendVerify({ challengeId: body.challengeId, address: other.addressHex, ...other.sign(body.message) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/^You signed with a different wallet/);
    const res2 = await sendVerify({ challengeId: body.challengeId, ...other.sign(body.message) });
    expect(res2.status).toBe(401);
    expect(await apiState()).toBe("endpoints_confirmed");
  });

  it("refuses to reuse a consumed challenge", async () => {
    await passFileCheck();
    const { body } = await getWalletMessage();
    const signed = { challengeId: body.challengeId, ...wallet.sign(body.message) };
    expect((await sendVerify(signed)).status).toBe(200);
    await getSql()`update apis set state = 'endpoints_confirmed' where id = ${api.id}`;
    expect((await sendVerify(signed)).status).toBe(409);
  });

  it("refuses an expired challenge", async () => {
    await passFileCheck();
    const { body } = await getWalletMessage();
    await getSql()`update challenges set expires_at = now() - interval '1 minute' where id = ${body.challengeId}`;
    const res = await sendVerify({ challengeId: body.challengeId, ...wallet.sign(body.message) });
    expect(res.status).toBe(409);
    expect(await apiState()).toBe("endpoints_confirmed");
  });

  it("returns 404 for another seller's API", async () => {
    const intruder = await seedSeller();
    const res = await challengeFile(jsonRequest(`/api/apis/${api.id}/challenge-file`, { cookie: cookieFor(intruder) }), ctx(api.id));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run "app/api/apis/[apiId]/ownership/ownership.test.ts"`
Expected: FAIL, `Failed to resolve import "../challenge-file/route"`.

- [ ] **Step 3: Write the challenges repo**

`apps/web/lib/repo/challenges.ts`:
```ts
import { randomBytes } from "node:crypto";
import { newId } from "@hirakumi/core";
import type { Sql } from "../db";

export const HTTP_CHALLENGE_TTL_MINUTES = 30;

export type HttpChallenge = { id: string; token: string; expiresAt: Date; passedAt: string | null };

/** Newest unconsumed, unexpired http challenge; the gateway compares against the same row (contract addition A2). */
export async function findCurrentHttpChallenge(sql: Sql, apiId: string): Promise<HttpChallenge | null> {
  const [row] = await sql<HttpChallenge[]>`
    select id, token, expires_at, proof->>'passedAt' as passed_at from challenges
    where api_id = ${apiId} and kind = 'http' and consumed_at is null and expires_at > now()
    order by expires_at desc limit 1`;
  return row ?? null;
}

export async function getOrCreateHttpChallenge(sql: Sql, apiId: string): Promise<HttpChallenge> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`http-challenge|${apiId}`}))`;
    const [existing] = await tx<HttpChallenge[]>`
      select id, token, expires_at, proof->>'passedAt' as passed_at from challenges
      where api_id = ${apiId} and kind = 'http' and consumed_at is null and expires_at > now()
      order by expires_at desc limit 1`;
    if (existing) return existing;
    const token = `hirakumi-verification=${apiId}.${randomBytes(24).toString("base64url")}`;
    const [created] = await tx<HttpChallenge[]>`
      insert into challenges (id, api_id, kind, token, expires_at)
      values (${newId("ch")}, ${apiId}, 'http', ${token}, now() + make_interval(mins => ${HTTP_CHALLENGE_TTL_MINUTES}))
      returning id, token, expires_at, null::text as passed_at`;
    return created;
  });
}

export async function markHttpPassed(sql: Sql, challengeId: string, triedUrl: string): Promise<void> {
  await sql`
    update challenges
    set proof = coalesce(proof, '{}'::jsonb) || ${JSON.stringify({ passedAt: new Date().toISOString(), triedUrl })}::jsonb
    where id = ${challengeId}`;
}

export async function hasPassedHttpChallenge(sql: Sql, apiId: string): Promise<boolean> {
  const rows = await sql`
    select 1 from challenges
    where api_id = ${apiId} and kind = 'http' and consumed_at is null and expires_at > now()
      and proof->>'passedAt' is not null
    limit 1`;
  return rows.length > 0;
}

export async function createWalletChallenge(
  sql: Sql,
  a: { apiId: string; nonce: string; expiresAt: Date; message: string },
): Promise<string> {
  const id = newId("ch");
  await sql`
    insert into challenges (id, api_id, kind, token, expires_at, proof)
    values (${id}, ${a.apiId}, 'wallet', ${a.nonce}, ${a.expiresAt}, ${JSON.stringify({ message: a.message })}::jsonb)`;
  return id;
}

export async function getOpenWalletChallenge(sql: Sql, challengeId: string, apiId: string): Promise<{ id: string; message: string } | null> {
  const [row] = await sql<{ id: string; message: string | null }[]>`
    select id, proof->>'message' as message from challenges
    where id = ${challengeId} and api_id = ${apiId} and kind = 'wallet' and consumed_at is null and expires_at > now()`;
  return row && row.message ? { id: row.id, message: row.message } : null;
}

class OwnershipRace extends Error {}

/** One transaction: consume the wallet challenge, advance the state, consume the http challenge. */
export async function finalizeOwnership(
  sql: Sql,
  a: { apiId: string; walletChallengeId: string; signature: string; key: string },
): Promise<boolean> {
  try {
    return await sql.begin(async (tx) => {
      const consumed = await tx`
        update challenges
        set consumed_at = now(),
            proof = coalesce(proof, '{}'::jsonb) || ${JSON.stringify({ signature: a.signature, key: a.key, verifiedAt: new Date().toISOString() })}::jsonb
        where id = ${a.walletChallengeId} and api_id = ${a.apiId} and kind = 'wallet' and consumed_at is null and expires_at > now()
        returning id`;
      if (consumed.length !== 1) throw new OwnershipRace();
      const moved = await tx`
        update apis set state = 'ownership_verified' where id = ${a.apiId} and state = 'endpoints_confirmed' returning id`;
      if (moved.length !== 1) throw new OwnershipRace();
      await tx`update challenges set consumed_at = now() where api_id = ${a.apiId} and kind = 'http' and consumed_at is null`;
      return true;
    });
  } catch (e) {
    if (e instanceof OwnershipRace) return false;
    throw e;
  }
}
```

- [ ] **Step 4: Write the four routes**

`apps/web/app/api/apis/[apiId]/challenge-file/route.ts`:
```ts
import type { ApiRouteContext } from "@/lib/http";
import { getOrCreateHttpChallenge } from "@/lib/repo/challenges";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

export async function GET(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  if (api.state !== "endpoints_confirmed") return wrongStep(api);
  const challenge = await getOrCreateHttpChallenge(sql, api.id);
  return new Response(challenge.token, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${api.id}.txt"`,
      "cache-control": "no-store",
    },
  });
}
```

`apps/web/app/api/apis/[apiId]/ownership/http-check/route.ts`:
```ts
import { GatewayError, getGateway, type ChallengeCheck } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { findCurrentHttpChallenge, markHttpPassed } from "@/lib/repo/challenges";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  if (api.state !== "endpoints_confirmed") return wrongStep(api);
  const challenge = await findCurrentHttpChallenge(sql, api.id);
  if (!challenge) {
    return errorJson(409, "Download the verification file first. If you downloaded it more than 30 minutes ago, download it again and replace the old one.");
  }
  let result: ChallengeCheck;
  try {
    result = await getGateway().checkChallenge(api.id);
  } catch (e) {
    if (e instanceof GatewayError) {
      console.error(e.message);
      return errorJson(502, e.userMessage);
    }
    throw e;
  }
  if (result.ok) await markHttpPassed(sql, challenge.id, result.triedUrl);
  return json(result);
}
```

`apps/web/app/api/apis/[apiId]/ownership/wallet-challenge/route.ts`:
```ts
import { randomBytes } from "node:crypto";
import { buildWalletChallenge } from "@hirakumi/core";
import { env } from "@/lib/env";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { createWalletChallenge, hasPassedHttpChallenge } from "@/lib/repo/challenges";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

const WALLET_CHALLENGE_TTL_MS = 30 * 60 * 1000;

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  if (api.state !== "endpoints_confirmed") return wrongStep(api);
  if (!(await hasPassedHttpChallenge(sql, api.id))) return errorJson(409, "Check your verification file first.");
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + WALLET_CHALLENGE_TTL_MS);
  const message = buildWalletChallenge({
    domain: new URL(env.webBaseUrl()).host,
    sellerId: session.sellerId,
    apiId: api.id,
    origin: api.origin,
    payTo: session.addr,
    network: "cardano:preprod",
    nonce,
    expires: expiresAt.toISOString(),
  });
  const challengeId = await createWalletChallenge(sql, { apiId: api.id, nonce, expiresAt, message });
  return json({ challengeId, message });
}
```

`apps/web/app/api/apis/[apiId]/ownership/verify/route.ts`:
```ts
import { AddressError, toPreprodBech32, verifyCip30Signature } from "@/lib/cardano";
import { shortAddress } from "@/lib/copy";
import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { finalizeOwnership, getOpenWalletChallenge, hasPassedHttpChallenge } from "@/lib/repo/challenges";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  if (api.state !== "endpoints_confirmed") return wrongStep(api);
  const body = await readJson(req);
  if (!body || typeof body.challengeId !== "string" || typeof body.signature !== "string" || typeof body.key !== "string") {
    return errorJson(400, "The signature was incomplete. Start the signing step again.");
  }
  if (typeof body.address === "string") {
    let signer: string;
    try {
      signer = toPreprodBech32(body.address);
    } catch (e) {
      if (e instanceof AddressError) return errorJson(400, e.message);
      throw e;
    }
    if (signer !== session.addr) {
      return errorJson(401, `You signed with a different wallet than the one you signed in with. Switch your wallet to ${shortAddress(session.addr)} and try again.`);
    }
  }
  const challenge = await getOpenWalletChallenge(sql, body.challengeId, api.id);
  if (!challenge) return errorJson(409, "This signing request expired or was already used. Start the signing step again.");
  if (!(await hasPassedHttpChallenge(sql, api.id))) {
    return errorJson(409, "Check your verification file again. Checks expire after 30 minutes.");
  }
  // Authoritative check: the signature must come from the seller's own payout address.
  const ok = await verifyCip30Signature(challenge.message, { signature: body.signature, key: body.key }, session.addr);
  if (!ok) return errorJson(401, "The signature didn't match this message and your wallet. Start the signing step again.");
  const done = await finalizeOwnership(sql, { apiId: api.id, walletChallengeId: challenge.id, signature: body.signature, key: body.key });
  if (!done) return errorJson(409, "This signing request expired or was already used. Start the signing step again.");
  return json({ state: "ownership_verified" });
}
```

- [ ] **Step 5: Run the route test (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run "app/api/apis/[apiId]/ownership/ownership.test.ts"`
Expected: PASS (10 tests). If the `message` assertions fail because `buildWalletChallenge` (P1) formats fields differently, keep the assertions about content (`apiId`, address, origin) and ask P1. Never weaken the signature tests.

- [ ] **Step 6: Write the failing panel test**

`apps/web/components/ownership-panel.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { OwnershipPanel } from "./ownership-panel";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const FILE_URL = "https://price.example.dev/.well-known/hirakumi/api_1.txt";

function installWallet(signData = vi.fn(async () => ({ signature: "84a1", key: "a401" }))) {
  window.cardano = {
    eternl: {
      name: "eternl",
      icon: "",
      enable: async () => ({
        getNetworkId: async () => 0,
        getChangeAddress: async () => "00beef",
        getUsedAddresses: async () => ["00beef"],
        signData,
      }),
    },
  };
  return signData;
}

afterEach(() => {
  delete window.cardano;
  vi.unstubAllGlobals();
  nav.push.mockReset();
});

describe("OwnershipPanel", () => {
  it("shows where the file must be served and links the download", () => {
    installWallet();
    render(<OwnershipPanel apiId="api_1" fileUrl={FILE_URL} initiallyPassed={false} />);
    expect(screen.getByText(FILE_URL)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download the file" })).toHaveAttribute("href", "/api/apis/api_1/challenge-file");
  });

  it("shows the URL tried and the reason when the check fails", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ ok: false, triedUrl: FILE_URL, detail: "Got HTTP 404 Not Found." })));
    render(<OwnershipPanel apiId="api_1" fileUrl={FILE_URL} initiallyPassed={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Check" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`We tried ${FILE_URL}`);
    expect(alert).toHaveTextContent("Got HTTP 404 Not Found.");
    expect(await screen.findByRole("button", { name: "Sign with eternl" })).toBeDisabled();
  });

  it("enables signing after a passing check, signs the server's message and opens Review", async () => {
    const signData = installWallet();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, triedUrl: FILE_URL, detail: "The file matched." }))
      .mockResolvedValueOnce(jsonResponse({ challengeId: "ch_1", message: "Hirakumi ownership\napi: api_1" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ownership_verified" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<OwnershipPanel apiId="api_1" fileUrl={FILE_URL} initiallyPassed={false} />);
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Found it. Your file matches.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign with eternl" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/review"));
    expect(signData).toHaveBeenCalledWith("00beef", Buffer.from("Hirakumi ownership\napi: api_1").toString("hex"));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ challengeId: "ch_1", address: "00beef", signature: "84a1", key: "a401" });
  });

  it("shows the gateway outage message", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "We couldn't reach the Hirakumi checker. Try again in a minute." }, 502)));
    render(<OwnershipPanel apiId="api_1" fileUrl={FILE_URL} initiallyPassed={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't reach the Hirakumi checker.");
  });
});
```

- [ ] **Step 7: Run the panel test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run components/ownership-panel.test.tsx`
Expected: FAIL, `Failed to resolve import "./ownership-panel"`.

- [ ] **Step 8: Write the panel and page**

`apps/web/components/ownership-panel.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";
import { connectWallet, listWallets, signText, walletErrorMessage, type WalletInfo } from "@/lib/wallet-client";

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "failed"; triedUrl: string; detail: string }
  | { kind: "error"; text: string };
type SignState = { kind: "idle" } | { kind: "working"; text: string; message?: string } | { kind: "error"; text: string };

export function OwnershipPanel({ apiId, fileUrl, initiallyPassed }: { apiId: string; fileUrl: string; initiallyPassed: boolean }) {
  const router = useRouter();
  const [passed, setPassed] = useState(initiallyPassed);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [sign, setSign] = useState<SignState>({ kind: "idle" });
  const [wallets, setWallets] = useState<WalletInfo[]>([]);

  useEffect(() => {
    setWallets(listWallets());
    const t = setTimeout(() => setWallets(listWallets()), 800);
    return () => clearTimeout(t);
  }, []);

  async function runCheck() {
    setCheck({ kind: "checking" });
    try {
      const result = await postJson<{ ok: boolean; triedUrl: string; detail: string }>(`/api/apis/${apiId}/ownership/http-check`, {});
      if (result.ok) {
        setPassed(true);
        setCheck({ kind: "idle" });
      } else {
        setPassed(false);
        setCheck({ kind: "failed", triedUrl: result.triedUrl, detail: result.detail });
      }
    } catch (e) {
      setCheck({ kind: "error", text: e instanceof RequestError ? e.message : "Something went wrong. Try again." });
    }
  }

  async function runSign(walletId: string) {
    try {
      setSign({ kind: "working", text: "Connecting to your wallet…" });
      const { api, addressHex } = await connectWallet(walletId);
      const challenge = await postJson<{ challengeId: string; message: string }>(`/api/apis/${apiId}/ownership/wallet-challenge`, {});
      setSign({ kind: "working", text: "Approve this message in your wallet. It costs nothing and moves no funds.", message: challenge.message });
      const sig = await signText(api, addressHex, challenge.message);
      await postJson(`/api/apis/${apiId}/ownership/verify`, { challengeId: challenge.challengeId, address: addressHex, ...sig });
      router.push(`/apis/${apiId}/review`);
    } catch (e) {
      setSign({ kind: "error", text: walletErrorMessage(e) });
    }
  }

  return (
    <ol className="space-y-8">
      <li className="space-y-2">
        <h2 className="font-medium">1. Put the verification file on your server</h2>
        <p className="text-sm text-muted-foreground">Download the file and upload it, unchanged, so it opens at:</p>
        <code className="block break-all rounded bg-muted p-2 text-sm">{fileUrl}</code>
        <a href={`/api/apis/${apiId}/challenge-file`} download className="text-sm underline">Download the file</a>
        <p className="text-xs text-muted-foreground">The file works once and expires after 30 minutes.</p>
      </li>
      <li className="space-y-2">
        <h2 className="font-medium">2. Check the file</h2>
        <Button variant="outline" disabled={check.kind === "checking"} onClick={runCheck}>
          {check.kind === "checking" ? "Checking…" : "Check"}
        </Button>
        {passed && <p role="status" className="text-sm text-green-700">Found it. Your file matches.</p>}
        {check.kind === "failed" && (
          <div role="alert" className="space-y-1 text-sm text-destructive">
            <p>We couldn't confirm the file. We tried {check.triedUrl}</p>
            <p>{check.detail}</p>
          </div>
        )}
        {check.kind === "error" && <p role="alert" className="text-sm text-destructive">{check.text}</p>}
      </li>
      <li className="space-y-2">
        <h2 className="font-medium">3. Sign with your wallet</h2>
        <p className="text-sm text-muted-foreground">
          Your wallet shows a message naming this API and the address buyers will pay. Signing costs nothing and moves no funds.
        </p>
        {wallets.length === 0 ? (
          <p className="text-sm">No Cardano wallet found in this browser. Install Eternl, switch it to preprod, then reload.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {wallets.map((w) => (
              <Button key={w.id} disabled={!passed || sign.kind === "working"} onClick={() => runSign(w.id)}>
                Sign with {w.name}
              </Button>
            ))}
          </div>
        )}
        {sign.kind === "working" && (
          <div role="status" className="space-y-2 text-sm">
            <p>{sign.text}</p>
            {sign.message && <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{sign.message}</pre>}
          </div>
        )}
        {sign.kind === "error" && <p role="alert" className="text-sm text-destructive">{sign.text}</p>}
      </li>
    </ol>
  );
}
```

`apps/web/app/apis/[apiId]/ownership/page.tsx`:
```tsx
import { httpChallengePath } from "@hirakumi/core";
import { redirect } from "next/navigation";
import { OwnershipPanel } from "@/components/ownership-panel";
import { getSql } from "@/lib/db";
import { stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { hasPassedHttpChallenge } from "@/lib/repo/challenges";

export default async function OwnershipPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/ownership`);
  if (api.state !== "endpoints_confirmed") redirect(`/apis/${apiId}/${stepForState(api.state)}`);
  const passed = await hasPassedHttpChallenge(getSql(), apiId);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Prove you own this API</h1>
      <p className="text-muted-foreground">
        Two quick checks stop anyone from selling someone else's API: a file on your server, and one signature from your wallet.
      </p>
      <OwnershipPanel apiId={apiId} fileUrl={`${api.origin}${httpChallengePath(apiId)}`} initiallyPassed={passed} />
    </section>
  );
}
```

- [ ] **Step 9: Run both tests (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run "app/api/apis/[apiId]/ownership/ownership.test.ts" components/ownership-panel.test.tsx`
Expected: PASS (14 tests).

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): Ownership screen with served challenge file, gateway check and wallet signature" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Review screen (promise, price, Publish)

**Files:**
- Create: `apps/web/lib/repo/rules.ts`, `apps/web/lib/repo/packs.ts`, `apps/web/app/api/apis/[apiId]/pricing/route.ts`, `apps/web/app/api/apis/[apiId]/publish/route.ts`, `apps/web/components/review-panel.tsx`, `apps/web/app/apis/[apiId]/review/page.tsx`
- Test: `apps/web/app/api/apis/[apiId]/review.test.ts`, `apps/web/components/review-panel.test.tsx`

**Interfaces:**
- Consumes: `parseTusdm`, `parsePackCalls`, `formatTusdm`, `perCallTusdm`, `MIN_PRICE_MICROS`, `MoneyError` (Task 3); `transitionState`, `listOnboardSteps` (Task 7); `reloadQuietly`, `setGatewayForTests` (Task 10); `loadOwnedApi`, `wrongStep` (Task 7); `postJson` (Task 6); `newId` (`@hirakumi/core`).
- Produces:
  - `listLatestRules(sql, apiId): Promise<RuleView[]>`; `countEnabledWithoutRule(sql, apiId): Promise<number>`
  - `getPack(sql, apiId): Promise<Pack | null>`; `savePricing(sql, { apiId, sellerId, calls, priceMicros: bigint, escrowPriceMicros: bigint }): Promise<RepoResult>`
  - `POST /api/apis/:apiId/pricing` body `{ packCalls: string, packPrice: string, escrowPrice: string }` (tUSDM decimals) → 200 `{ state: "priced", pack: { calls, priceMicros, escrowPriceMicros } }` | 400/409
  - `POST /api/apis/:apiId/publish` → 200 `{ state: "registering" }` | 409
  - `<ReviewPanel apiId state promises pack />`

- [ ] **Step 1: Write the failing route test**

`apps/web/app/api/apis/[apiId]/review.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { setGatewayForTests, type Gateway } from "@/lib/gateway";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedPack, seedRule, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST as pricing } from "./pricing/route";
import { POST as publish } from "./publish/route";

let seller: Seller;
let api: Api;
const reloadApi = vi.fn(async () => undefined);

async function setup(state: Api["state"]) {
  seller = await seedSeller();
  api = await seedApi(seller.id, state);
  const op = await seedOperation(api.id, { enabled: true });
  await seedRule(op.id);
}

function price(body: unknown, cookie = cookieFor(seller)) {
  return pricing(jsonRequest(`/api/apis/${api.id}/pricing`, { cookie, body }), ctx(api.id));
}
function pub(cookie = cookieFor(seller)) {
  return publish(jsonRequest(`/api/apis/${api.id}/publish`, { cookie, body: {} }), ctx(api.id));
}
async function state() {
  const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
  return row.state;
}

describe("pricing and publish", () => {
  beforeEach(async () => {
    await resetDb();
    reloadApi.mockClear();
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi, getHealth: vi.fn() } as Gateway);
  });
  afterEach(() => setGatewayForTests(null));

  it("stores 2.5 tUSDM as 2500000 micros and moves to priced", async () => {
    await setup("rule_built");
    const res = await price({ packCalls: "100", packPrice: "2.5", escrowPrice: "2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "priced", pack: { calls: 100, priceMicros: "2500000", escrowPriceMicros: "2000000" } });
    const packs = await getSql()<{ priceMicros: string }[]>`select price_micros::text as price_micros from packs where api_id = ${api.id}`;
    expect(packs).toEqual([{ priceMicros: "2500000" }]);
    expect(await state()).toBe("priced");
    expect(reloadApi).toHaveBeenCalledWith(api.id);
  });

  it("re-saving the price updates the same pack", async () => {
    await setup("rule_built");
    await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" });
    await price({ packCalls: "50", packPrice: "1.5", escrowPrice: "3" });
    const packs = await getSql()<{ calls: number }[]>`select calls from packs where api_id = ${api.id}`;
    expect(packs).toEqual([{ calls: 50 }]);
  });

  it("refuses a pack under 1 tUSDM in plain English", async () => {
    await setup("rule_built");
    const res = await price({ packCalls: "100", packPrice: "0.5", escrowPrice: "2" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "A pack must cost at least 1 tUSDM. Cardano can't move smaller token payments cheaply." });
  });

  it("explains a malformed amount", async () => {
    await setup("rule_built");
    const res = await price({ packCalls: "100", packPrice: "two", escrowPrice: "2" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Enter an amount like 2 or 2.50/);
  });

  it("still saves the price when the gateway reload fails", async () => {
    await setup("rule_built");
    reloadApi.mockRejectedValueOnce(new Error("down"));
    expect((await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" })).status).toBe(200);
  });

  it("refuses pricing before the test calls finished", async () => {
    await setup("ownership_verified");
    expect((await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" })).status).toBe(409);
  });

  it("refuses pricing when an enabled endpoint has no promise yet", async () => {
    await setup("rule_built");
    await seedOperation(api.id, { opId: "getHistory", path: "/history", enabled: true });
    const res = await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The test calls haven't finished for every endpoint yet. Wait a moment and reload." });
  });

  it("returns 404 for another seller's API", async () => {
    await setup("rule_built");
    const intruder = await seedSeller();
    expect((await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" }, cookieFor(intruder))).status).toBe(404);
  });

  it("publish before pricing is refused", async () => {
    await setup("rule_built");
    expect((await pub()).status).toBe(409);
    expect(await state()).toBe("rule_built");
  });

  it("publishes a priced API into registering", async () => {
    await setup("priced");
    await seedPack(api.id);
    const res = await pub();
    expect(res.status).toBe(200);
    expect(await state()).toBe("registering");
  });

  it("two concurrent publishes: exactly one succeeds", async () => {
    await setup("priced");
    await seedPack(api.id);
    const statuses = (await Promise.all([pub(), pub()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run "app/api/apis/[apiId]/review.test.ts"`
Expected: FAIL, `Failed to resolve import "./pricing/route"`.

- [ ] **Step 3: Write the repos and routes**

`apps/web/lib/repo/rules.ts`:
```ts
import type { Sql } from "../db";
import type { RuleView } from "../types";

/** Latest rule version for each enabled operation. */
export async function listLatestRules(sql: Sql, apiId: string): Promise<RuleView[]> {
  return sql<RuleView[]>`
    select distinct on (o.id)
      o.id as operation_id, o.op_id, o.method, o.path, r.version, r.hash, r.definition, r.plain_english
    from operations o join rules r on r.operation_id = o.id
    where o.api_id = ${apiId} and o.enabled
    order by o.id, r.version desc`;
}

export async function countEnabledWithoutRule(sql: Sql, apiId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from operations o
    where o.api_id = ${apiId} and o.enabled and not exists (select 1 from rules r where r.operation_id = o.id)`;
  return row.count;
}
```

`apps/web/lib/repo/packs.ts`:
```ts
import { newId } from "@hirakumi/core";
import type { Sql } from "../db";
import type { ApiState, Pack, RepoResult } from "../types";

export async function getPack(sql: Sql, apiId: string): Promise<Pack | null> {
  const [row] = await sql<Pack[]>`
    select id, calls, price_micros::text as price_micros, escrow_price_micros::text as escrow_price_micros
    from packs where api_id = ${apiId} order by id limit 1`;
  return row ?? null;
}

export async function savePricing(
  sql: Sql,
  a: { apiId: string; sellerId: string; calls: number; priceMicros: bigint; escrowPriceMicros: bigint },
): Promise<RepoResult> {
  return sql.begin(async (tx): Promise<RepoResult> => {
    const [api] = await tx<{ state: ApiState }[]>`
      select state from apis where id = ${a.apiId} and seller_id = ${a.sellerId} for update`;
    if (!api) return { ok: false, status: 404, error: "We couldn't find that API in your account." };
    if (api.state !== "rule_built" && api.state !== "priced") {
      return { ok: false, status: 409, error: "Prices can only be set after the test calls and before publishing." };
    }
    const [missing] = await tx<{ count: number }[]>`
      select count(*)::int as count from operations o
      where o.api_id = ${a.apiId} and o.enabled and not exists (select 1 from rules r where r.operation_id = o.id)`;
    if (missing.count > 0) {
      return { ok: false, status: 409, error: "The test calls haven't finished for every endpoint yet. Wait a moment and reload." };
    }
    const updated = await tx`
      update packs set calls = ${a.calls}, price_micros = ${a.priceMicros.toString()}::bigint,
        escrow_price_micros = ${a.escrowPriceMicros.toString()}::bigint
      where api_id = ${a.apiId} returning id`;
    if (updated.length === 0) {
      await tx`
        insert into packs (id, api_id, calls, price_micros, escrow_price_micros)
        values (${newId("pk")}, ${a.apiId}, ${a.calls}, ${a.priceMicros.toString()}::bigint, ${a.escrowPriceMicros.toString()}::bigint)`;
    }
    await tx`update apis set state = 'priced' where id = ${a.apiId}`;
    return { ok: true };
  });
}
```

`apps/web/app/api/apis/[apiId]/pricing/route.ts`:
```ts
import { reloadQuietly } from "@/lib/gateway";
import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { MIN_PRICE_MICROS, MoneyError, parsePackCalls, parseTusdm } from "@/lib/money";
import { savePricing } from "@/lib/repo/packs";
import { loadOwnedApi } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  const body = await readJson(req);
  if (!body) return errorJson(400, "Enter a pack size and prices.");
  let calls: number;
  let priceMicros: bigint;
  let escrowPriceMicros: bigint;
  try {
    calls = parsePackCalls(String(body.packCalls ?? ""));
    priceMicros = parseTusdm(String(body.packPrice ?? ""));
    escrowPriceMicros = parseTusdm(String(body.escrowPrice ?? ""));
  } catch (e) {
    if (e instanceof MoneyError) return errorJson(400, e.message);
    throw e;
  }
  if (priceMicros < MIN_PRICE_MICROS) {
    return errorJson(400, "A pack must cost at least 1 tUSDM. Cardano can't move smaller token payments cheaply.");
  }
  if (escrowPriceMicros < MIN_PRICE_MICROS) return errorJson(400, "A per-job hire must cost at least 1 tUSDM.");
  const result = await savePricing(sql, { apiId: api.id, sellerId: session.sellerId, calls, priceMicros, escrowPriceMicros });
  if (!result.ok) return errorJson(result.status, result.error);
  await reloadQuietly(api.id);
  return json({
    state: "priced",
    pack: { calls, priceMicros: priceMicros.toString(), escrowPriceMicros: escrowPriceMicros.toString() },
  });
}
```

`apps/web/app/api/apis/[apiId]/publish/route.ts`:
```ts
import { reloadQuietly } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { transitionState } from "@/lib/repo/apis";
import { loadOwnedApi } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  // Only 'priced' can publish; the conditional update makes a double click a no-op.
  const moved = await transitionState(sql, { apiId: api.id, sellerId: session.sellerId, from: ["priced"], to: "registering" });
  if (!moved) return errorJson(409, "Save a price before publishing. If you already published, reload the page.");
  await reloadQuietly(api.id);
  return json({ state: "registering" });
}
```

- [ ] **Step 4: Run the route test (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run "app/api/apis/[apiId]/review.test.ts"`
Expected: PASS (11 tests).

- [ ] **Step 5: Write the failing panel test**

`apps/web/components/review-panel.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuleView } from "@/lib/types";
import { jsonResponse } from "@/test/http";
import { ReviewPanel } from "./review-panel";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const promises: RuleView[] = [{
  operationId: "op_1", opId: "getPrice", method: "GET", path: "/price", version: 1, hash: "sha256:abc",
  definition: { version: 1, schema: { properties: { last_updated: { type: "string", maxAgeSeconds: 300 } } } },
  plainEnglish: 'The response has a number "price" and a "last_updated" time under 5 minutes old.',
}];

afterEach(() => {
  vi.unstubAllGlobals();
  nav.push.mockReset();
  nav.refresh.mockReset();
});

describe("ReviewPanel", () => {
  it("shows the promise in plain English with the exact check underneath", () => {
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    expect(screen.getByText(promises[0].plainEnglish!)).toBeInTheDocument();
    expect(screen.getByText("Show the exact check (JSON)")).toBeInTheDocument();
    expect(screen.getByText(/"last_updated"/)).toBeInTheDocument();
  });

  it("suggests 100 calls for 2 tUSDM and shows the per-call price", () => {
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    expect(screen.getByLabelText("Calls per pack")).toHaveValue("100");
    expect(screen.getByLabelText("Pack price (tUSDM)")).toHaveValue("2");
    expect(screen.getByText("About 0.02 tUSDM per call.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("saves the price as typed and refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ state: "priced" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    await user.clear(screen.getByLabelText("Pack price (tUSDM)"));
    await user.type(screen.getByLabelText("Pack price (tUSDM)"), "2.5");
    await user.click(screen.getByRole("button", { name: "Save price" }));
    await vi.waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ packCalls: "100", packPrice: "2.5", escrowPrice: "2" });
  });

  it("publishes when priced and opens the overview", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ state: "registering" })));
    render(<ReviewPanel apiId="api_1" state="priced" promises={promises}
      pack={{ id: "pk_1", calls: 100, priceMicros: "2000000", escrowPriceMicros: "2000000" }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Publish" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/overview"));
  });

  it("shows the server's error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "A pack must cost at least 1 tUSDM. Cardano can't move smaller token payments cheaply." }, 400)));
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save price" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A pack must cost at least 1 tUSDM.");
  });
});
```

- [ ] **Step 6: Run the panel test (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run components/review-panel.test.tsx`
Expected: FAIL, `Failed to resolve import "./review-panel"`.

- [ ] **Step 7: Write the panel and page**

`apps/web/components/review-panel.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson, RequestError } from "@/lib/client-fetch";
import { formatTusdm, parsePackCalls, parseTusdm, perCallTusdm } from "@/lib/money";
import type { Pack, RuleView } from "@/lib/types";

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "saved" } | { kind: "error"; text: string };

export function ReviewPanel({ apiId, state, promises, pack }: {
  apiId: string;
  state: "rule_built" | "priced";
  promises: RuleView[];
  pack: Pack | null;
}) {
  const router = useRouter();
  const [calls, setCalls] = useState(pack ? String(pack.calls) : "100");
  const [price, setPrice] = useState(pack ? formatTusdm(pack.priceMicros) : "2");
  const [escrow, setEscrow] = useState(pack ? formatTusdm(pack.escrowPriceMicros) : "2");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const perCall = useMemo(() => {
    try {
      return perCallTusdm(parseTusdm(price), parsePackCalls(calls));
    } catch {
      return null;
    }
  }, [price, calls]);

  async function run(action: () => Promise<void>) {
    setStatus({ kind: "busy" });
    try {
      await action();
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof RequestError ? e.message : "Something went wrong. Try again." });
    }
  }

  const save = () => run(async () => {
    await postJson(`/api/apis/${apiId}/pricing`, { packCalls: calls, packPrice: price, escrowPrice: escrow });
    setStatus({ kind: "saved" });
    router.refresh();
  });

  const publish = () => run(async () => {
    await postJson(`/api/apis/${apiId}/publish`, {});
    router.push(`/apis/${apiId}/overview`);
  });

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-lg font-medium">Your promise to buyers</h2>
        <p className="text-sm text-muted-foreground">
          A buyer's credit is used only when your response keeps this promise. Otherwise the call is free.
        </p>
        {promises.map((p) => (
          <div key={p.operationId} className="space-y-2 rounded-lg border p-4">
            <p className="font-mono text-sm">{p.method.toUpperCase()} {p.path}</p>
            <p>{p.plainEnglish ?? "The plain-English summary isn't ready yet. The exact check is below."}</p>
            <details>
              <summary className="cursor-pointer text-sm">Show the exact check (JSON)</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(p.definition, null, 2)}</pre>
              <p className="text-xs text-muted-foreground">Fingerprint: {p.hash}</p>
            </details>
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Price</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="pack-calls" className="text-sm font-medium">Calls per pack</label>
            <Input id="pack-calls" type="text" inputMode="numeric" value={calls} onChange={(e) => setCalls(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="pack-price" className="text-sm font-medium">Pack price (tUSDM)</label>
            <Input id="pack-price" type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="escrow-price" className="text-sm font-medium">Price per job hire (tUSDM)</label>
            <Input id="escrow-price" type="text" inputMode="decimal" value={escrow} onChange={(e) => setEscrow(e.target.value)} />
          </div>
        </div>
        {perCall && <p className="text-sm text-muted-foreground">About {perCall} tUSDM per call.</p>}
        <p className="text-sm text-muted-foreground">
          Pack payments go straight to your wallet. For per-job hires, Masumi holds the payment and keeps 5%.
        </p>
        <Button variant="outline" disabled={status.kind === "busy"} onClick={save}>Save price</Button>
        {status.kind === "saved" && <p role="status" className="text-sm text-green-700">Saved.</p>}
      </section>

      <section className="space-y-2">
        <Button disabled={state !== "priced" || status.kind === "busy"} onClick={publish}>Publish</Button>
        {state !== "priced" && <p className="text-sm text-muted-foreground">Save a price to publish.</p>}
        {status.kind === "error" && <p role="alert" className="text-sm text-destructive">{status.text}</p>}
      </section>
    </div>
  );
}
```

`apps/web/app/apis/[apiId]/review/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { ReviewPanel } from "@/components/review-panel";
import { ErrorState, WaitingState } from "@/components/states";
import { StepList } from "@/components/step-list";
import { getSql } from "@/lib/db";
import { firstFailedStep, stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { listOnboardSteps } from "@/lib/repo/apis";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";

export default async function ReviewPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/review`);
  const sql = getSql();
  const heading = <h1 className="text-2xl font-semibold">Review and publish</h1>;

  if (api.state === "ownership_verified") {
    const steps = await listOnboardSteps(sql, apiId);
    const failure = firstFailedStep(steps);
    return (
      <section className="space-y-4">
        {heading}
        {failure ? (
          <ErrorState title="Your test calls didn't pass" detail={failure} />
        ) : (
          <WaitingState title="Running test calls on your API"
            detail="Hirakumi calls each endpoint at least 5 times to learn what a good response looks like. This page updates by itself.">
            <StepList steps={steps} />
          </WaitingState>
        )}
      </section>
    );
  }
  if (api.state !== "rule_built" && api.state !== "priced") redirect(`/apis/${apiId}/${stepForState(api.state)}`);

  const [promises, pack] = await Promise.all([listLatestRules(sql, apiId), getPack(sql, apiId)]);
  return (
    <section className="space-y-4">
      {heading}
      {promises.length === 0 ? (
        <WaitingState title="Writing your promise" detail="The test calls finished; the promise appears here in a moment." />
      ) : (
        <ReviewPanel apiId={apiId} state={api.state} promises={promises} pack={pack} />
      )}
    </section>
  );
}
```

- [ ] **Step 8: Run both tests and the full suite (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run "app/api/apis/[apiId]/review.test.ts" components/review-panel.test.tsx && pnpm --filter @hirakumi/web test`
Expected: PASS (16 new tests; the full suite is green).

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): Review screen with plain-English promise, pack and escrow pricing, and Publish" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Hour-10 checkpoint — Setup → Review against a local database**

Run four terminals from the repo root, with `apps/web/.env.local` as in Task 6 Step 9 plus `GATEWAY_INTERNAL_URL=http://127.0.0.1:4999` and `INTERNAL_TOKEN=change-me-32-bytes`:
```bash
psql postgres://hirakumi:hirakumi@localhost:5432/hirakumi -f db/migrations/0001_init.sql   # once, on a fresh DB
INTERNAL_TOKEN=change-me-32-bytes pnpm --filter @hirakumi/web dev:gateway
pnpm --filter @hirakumi/web dev
export DATABASE_URL=postgres://hirakumi:hirakumi@localhost:5432/hirakumi   # for dev:coworker below
```
In the browser: sign in with Eternl (preprod), then on `/apis/new` paste `https://price.example.dev/openapi.json` and click Continue. The page shows "Reading your API description". Run `pnpm --filter @hirakumi/web dev:coworker parse <apiId>` and the page switches to the endpoint list within 2 seconds. Tick `GET /price`, choose it for per-job hires, and click Confirm endpoints. On Ownership, download the file, click Check (the mock says it matched), click "Sign with eternl" and approve. On Review you see "Running test calls"; run `pnpm --filter @hirakumi/web dev:coworker build-rules <apiId>` and the promise appears. Click Save price, then Publish, and the overview shows "Registering on the Masumi network" once Task 13 lands; until then a 404 is expected.
Expected: every transition happens, and `select state from apis` shows `registering`. Also check the error state: run `pnpm --filter @hirakumi/web dev:coworker fail <newApiId> parse` on a fresh API, and the Endpoints page shows the Swagger 2.0 message.

### Task 13: Sales screen (pack sales with Cardanoscan links, escrow jobs)

**Files:**
- Create: `apps/web/lib/repo/stats.ts`, `apps/web/components/sales-tables.tsx`, `apps/web/app/apis/[apiId]/sales/page.tsx`
- Modify: `apps/web/test/factories.ts` (append seeders), `apps/web/lib/env.ts` (add `escrowSweepNotice`)
- Test: `apps/web/lib/repo/stats.test.ts`, `apps/web/components/sales-tables.test.tsx`

**Interfaces:**
- Consumes: contract tables `credit_tokens`, `packs`, `jobs` (read-only); `PACK_STATUS_LABEL`, `JOB_STATUS_LABEL`, `cardanoscanTxUrl`, `shortAddress`, `formatTime` (Task 3); `formatTusdm` (Task 3); `EmptyState` (Task 7); `loadApiPage` (Task 7).
- Produces:
  - `type PackSale = { id: string; createdAt: Date; payer: string | null; calls: number; priceMicros: string; status: "pending" | "active" | "exhausted" | "revoked"; remaining: number; txHash: string | null }`; `listPackSales(sql, apiId, limit?): Promise<PackSale[]>`
  - `type EscrowJob = { id: string; createdAt: Date; status: "awaiting_payment" | "running" | "completed" | "failed" | "expired"; identifierFromPurchaser: string; blockchainIdentifier: string | null; failureReasons: unknown }`; `listEscrowJobs(sql, apiId, limit?): Promise<EscrowJob[]>`
  - `<PackSalesTable sales />`, `<EscrowJobsTable jobs />`
  - `env.escrowSweepNotice(): boolean` (env `ESCROW_SWEEP_NOTICE=1` when the spike finds escrow can't pay the seller directly; spec §6.2 step 5)
  - Factories: `seedCreditToken(apiId, packId, over?)`, `seedCall(apiId, over?)`, `seedJob(apiId, over?)`, `seedHealthEvent(apiId, from, to, at, reasons?)`

- [ ] **Step 1: Append the seeders and the env flag**

Append to `apps/web/test/factories.ts`:
```ts
export async function seedCreditToken(
  apiId: string,
  packId: string,
  over: Partial<{ status: "pending" | "active" | "exhausted" | "revoked"; remaining: number; payer: string | null;
    txHash: string | null; createdAt: Date }> = {},
): Promise<{ id: string }> {
  const [row] = await getSql()<{ id: string }[]>`
    insert into credit_tokens (id, api_id, pack_id, token_hash, payer, status, remaining, payment_payload_hash, tx_hash, created_at)
    values (${newId("ct")}, ${apiId}, ${packId}, ${randomBytes(32).toString("hex")}, ${over.payer ?? "addr_test1buyer"},
            ${over.status ?? "active"}, ${over.remaining ?? 100}, ${randomBytes(32).toString("hex")},
            ${over.txHash === undefined ? randomBytes(32).toString("hex") : over.txHash}, ${over.createdAt ?? new Date()})
    returning id`;
  return row;
}

export async function seedCall(
  apiId: string,
  over: Partial<{ kind: "credit" | "escrow" | "probe" | "preview"; verdict: "pass" | "fail" | "n/a";
    execution: "upstream_ok" | "upstream_error" | "timeout" | "blocked"; createdAt: Date }> = {},
): Promise<void> {
  await getSql()`
    insert into calls (id, kind, api_id, op_id, execution, verdict, created_at)
    values (${newId("call")}, ${over.kind ?? "credit"}, ${apiId}, 'getPrice', ${over.execution ?? "upstream_ok"},
            ${over.verdict ?? "pass"}, ${over.createdAt ?? new Date()})`;
}

export async function seedJob(
  apiId: string,
  over: Partial<{ status: "awaiting_payment" | "running" | "completed" | "failed" | "expired"; failureReasons: string[] | null;
    createdAt: Date }> = {},
): Promise<{ id: string }> {
  const [row] = await getSql()<{ id: string }[]>`
    insert into jobs (id, api_id, identifier_from_purchaser, input, input_hash, status, failure_reasons, created_at)
    values (${newId("job")}, ${apiId}, 'buyer-ref-1', '{}'::jsonb, 'hash', ${over.status ?? "completed"},
            ${JSON.stringify(over.failureReasons ?? null)}::jsonb, ${over.createdAt ?? new Date()})
    returning id`;
  return row;
}

export async function seedHealthEvent(apiId: string, from: Health, to: Health, at: Date, reasons: string[] = []): Promise<void> {
  await getSql()`
    insert into health_events (api_id, from_health, to_health, reasons, at)
    values (${apiId}, ${from}, ${to}, ${JSON.stringify(reasons)}::jsonb, ${at})`;
}
```

In `apps/web/lib/env.ts`, add inside the `env` object:
```ts
  escrowSweepNotice: () => process.env.ESCROW_SWEEP_NOTICE === "1",
```

- [ ] **Step 2: Write the failing tests**

`apps/web/lib/repo/stats.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedCreditToken, seedJob, seedPack, seedSeller } from "@/test/factories";
import { listEscrowJobs, listPackSales } from "./stats";

describe("sales", () => {
  beforeEach(resetDb);

  it("lists pack sales newest first with the pack price and transaction hash", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id, { priceMicros: "2000000", calls: 100 });
    await seedCreditToken(api.id, pack.id, { txHash: "aaa", createdAt: new Date("2026-10-06T10:00:00Z") });
    await seedCreditToken(api.id, pack.id, { txHash: "bbb", remaining: 40, createdAt: new Date("2026-10-06T11:00:00Z") });
    const sales = await listPackSales(getSql(), api.id);
    expect(sales.map((s) => s.txHash)).toEqual(["bbb", "aaa"]);
    expect(sales[0]).toMatchObject({ calls: 100, priceMicros: "2000000", remaining: 40, status: "active" });
  });

  it("lists escrow jobs with failure reasons", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    await seedJob(api.id, { status: "failed", failureReasons: ["$.price is missing"] });
    const jobs = await listEscrowJobs(getSql(), api.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "failed", failureReasons: ["$.price is missing"], identifierFromPurchaser: "buyer-ref-1" });
  });
});
```

`apps/web/components/sales-tables.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EscrowJob, PackSale } from "@/lib/repo/stats";
import { EscrowJobsTable, PackSalesTable } from "./sales-tables";

const sale: PackSale = {
  id: "ct_1", createdAt: new Date("2026-10-06T10:00:00Z"), payer: "addr_test1qqbuyerbuyerbuyerbuyer", calls: 100,
  priceMicros: "2000000", status: "active", remaining: 99, txHash: "abc123",
};

describe("sales tables", () => {
  it("links each paid pack to Cardanoscan", () => {
    render(<PackSalesTable sales={[sale]} />);
    expect(screen.getByRole("link", { name: "View on Cardanoscan" })).toHaveAttribute("href", "https://preprod.cardanoscan.io/transaction/abc123");
    expect(screen.getByText("2 tUSDM")).toBeInTheDocument();
    expect(screen.getByText("99 of 100 left")).toBeInTheDocument();
    expect(screen.getByText("Paid, credits available")).toBeInTheDocument();
  });

  it("says when a payment has no transaction yet", () => {
    render(<PackSalesTable sales={[{ ...sale, status: "pending", txHash: null }]} />);
    expect(screen.getByText("Not recorded yet")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the payment to settle")).toBeInTheDocument();
  });

  it("has plain-language empty states", () => {
    render(<><PackSalesTable sales={[]} /><EscrowJobsTable jobs={[]} /></>);
    expect(screen.getByText("No pack sales yet")).toBeInTheDocument();
    expect(screen.getByText("No per-job hires yet")).toBeInTheDocument();
  });

  it("explains failed jobs and the automatic refund", () => {
    const job: EscrowJob = { id: "job_1", createdAt: new Date("2026-10-06T10:00:00Z"), status: "failed",
      identifierFromPurchaser: "ref", blockchainIdentifier: null, failureReasons: ["$.price is missing"] };
    render(<EscrowJobsTable jobs={[job]} />);
    expect(screen.getByText("Didn't pass, Masumi refunds the buyer automatically")).toBeInTheDocument();
    expect(screen.getByText("$.price is missing")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/repo/stats.test.ts components/sales-tables.test.tsx`
Expected: FAIL, `Failed to resolve import "./stats"` and `"./sales-tables"`.

- [ ] **Step 4: Write the repo, tables and page**

`apps/web/lib/repo/stats.ts`:
```ts
import type { Sql } from "../db";

export type PackSale = {
  id: string;
  createdAt: Date;
  payer: string | null;
  calls: number;
  priceMicros: string;
  status: "pending" | "active" | "exhausted" | "revoked";
  remaining: number;
  txHash: string | null;
};

export type EscrowJob = {
  id: string;
  createdAt: Date;
  status: "awaiting_payment" | "running" | "completed" | "failed" | "expired";
  identifierFromPurchaser: string;
  blockchainIdentifier: string | null;
  failureReasons: unknown;
};

export async function listPackSales(sql: Sql, apiId: string, limit = 100): Promise<PackSale[]> {
  return sql<PackSale[]>`
    select t.id, t.created_at, t.payer, p.calls, p.price_micros::text as price_micros, t.status, t.remaining, t.tx_hash
    from credit_tokens t join packs p on p.id = t.pack_id
    where t.api_id = ${apiId}
    order by t.created_at desc limit ${limit}`;
}

export async function listEscrowJobs(sql: Sql, apiId: string, limit = 100): Promise<EscrowJob[]> {
  return sql<EscrowJob[]>`
    select id, created_at, status, identifier_from_purchaser, blockchain_identifier, failure_reasons
    from jobs where api_id = ${apiId}
    order by created_at desc limit ${limit}`;
}
```

`apps/web/components/sales-tables.tsx`:
```tsx
import { EmptyState } from "@/components/states";
import { cardanoscanTxUrl, formatTime, JOB_STATUS_LABEL, PACK_STATUS_LABEL, shortAddress } from "@/lib/copy";
import { formatTusdm } from "@/lib/money";
import type { EscrowJob, PackSale } from "@/lib/repo/stats";

export function PackSalesTable({ sales }: { sales: PackSale[] }) {
  if (sales.length === 0) {
    return <EmptyState title="No pack sales yet" detail="When an agent buys a pack, it shows up here with a link to the payment on Cardanoscan." />;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b">
          <th className="py-2">Date</th><th>Buyer</th><th>Credits</th><th>Price</th><th>Status</th><th>Payment</th>
        </tr>
      </thead>
      <tbody>
        {sales.map((s) => (
          <tr key={s.id} className="border-b">
            <td className="py-2">{formatTime(s.createdAt)}</td>
            <td>{s.payer ? shortAddress(s.payer) : "Unknown"}</td>
            <td>{`${s.remaining} of ${s.calls} left`}</td>
            <td>{`${formatTusdm(s.priceMicros)} tUSDM`}</td>
            <td>{PACK_STATUS_LABEL[s.status]}</td>
            <td>
              {s.txHash ? (
                <a href={cardanoscanTxUrl(s.txHash)} target="_blank" rel="noreferrer" className="underline">View on Cardanoscan</a>
              ) : (
                "Not recorded yet"
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function reasonsOf(job: EscrowJob): string[] {
  return Array.isArray(job.failureReasons) ? job.failureReasons.filter((r): r is string => typeof r === "string") : [];
}

export function EscrowJobsTable({ jobs }: { jobs: EscrowJob[] }) {
  if (jobs.length === 0) {
    return <EmptyState title="No per-job hires yet" detail="When someone hires your API through Masumi escrow, the job shows up here." />;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b">
          <th className="py-2">Date</th><th>Buyer reference</th><th>Status</th><th>What failed</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id} className="border-b align-top">
            <td className="py-2">{formatTime(j.createdAt)}</td>
            <td>{j.identifierFromPurchaser}</td>
            <td>{JOB_STATUS_LABEL[j.status]}</td>
            <td>
              <ul>{reasonsOf(j).map((r) => <li key={r}>{r}</li>)}</ul>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`apps/web/app/apis/[apiId]/sales/page.tsx`:
```tsx
import { EscrowJobsTable, PackSalesTable } from "@/components/sales-tables";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { loadApiPage } from "@/lib/page-auth";
import { listEscrowJobs, listPackSales } from "@/lib/repo/stats";

export default async function SalesPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  await loadApiPage(apiId, `/apis/${apiId}/sales`);
  const sql = getSql();
  const [sales, jobs] = await Promise.all([listPackSales(sql, apiId), listEscrowJobs(sql, apiId)]);
  return (
    <section className="space-y-8">
      <h1 className="text-2xl font-semibold">Sales</h1>
      <div className="space-y-3">
        <h2 className="text-lg font-medium">Credit packs</h2>
        <p className="text-sm text-muted-foreground">Pack payments go straight to your wallet in one transaction each.</p>
        <PackSalesTable sales={sales} />
      </div>
      <div className="space-y-3">
        <h2 className="text-lg font-medium">Per-job hires (Masumi escrow)</h2>
        <p className="text-sm text-muted-foreground">
          Masumi releases each passed job's payment after its unlock time and keeps 5%. A failed job is refunded to the buyer automatically.
        </p>
        {env.escrowSweepNotice() && (
          <p role="note" className="text-sm text-amber-700">
            During the demo, per-job earnings arrive in the Hirakumi collection wallet and we forward them to you by hand.
          </p>
        )}
        <EscrowJobsTable jobs={jobs} />
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Run the tests (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/repo/stats.test.ts components/sales-tables.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): Sales screen with Cardanoscan links for pack payments and escrow job outcomes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: API overview (health, calls, pass rate, earnings, downtime, buyer snippet), public page, retire

**Files:**
- Create: `apps/web/lib/snippet.ts`, `apps/web/components/buyer-snippet.tsx`, `apps/web/components/retire-button.tsx`, `apps/web/app/apis/[apiId]/overview/page.tsx`, `apps/web/app/p/[apiId]/page.tsx`, `apps/web/app/api/apis/[apiId]/retire/route.ts`
- Modify: `apps/web/lib/repo/stats.ts` (append `getOverviewStats`, `listIncidents`)
- Test: `apps/web/lib/snippet.test.ts`, `apps/web/lib/repo/overview-stats.test.ts`, `apps/web/app/api/apis/[apiId]/retire/retire.test.ts`

**Interfaces:**
- Consumes: `listPackSales`, `PackSalesTable` (Task 13); `getPack` (Task 12); `listLatestRules` (Task 12); `listOnboardSteps`, `transitionState`, `getLiveApi` (Task 7); `getGateway`, `reloadQuietly` (Task 10); `HealthBadge`, `WaitingState`, `EmptyState`, `StepList`, `AutoRefresh` (Task 7); `formatTusdm`, `formatTime` (Task 3); `env.publicBaseUrl()` (Task 2).
- Produces:
  - `type OverviewStats = { callsDay: number; passDay: number; failDay: number; passRate: number | null; packSales: number; packEarningsMicros: string; escrowJobs: number; escrowGrossMicros: string; escrowFeeMicros: string; escrowNetMicros: string }`; `getOverviewStats(sql, apiId): Promise<OverviewStats>`
  - `type Incident = { downAt: Date; upAt: Date | null; reasons: unknown; creditsUsed: number; callsNotPassed: number }`; `listIncidents(sql, apiId, limit?): Promise<Incident[]>`
  - `type SnippetInput = { gatewayBaseUrl: string; apiId: string; packId: string; packCalls: number; packPriceMicros: string; opId: string; method: string }`; `buildBuyerSnippet(i: SnippetInput): string` (≤ 20 lines, US6)
  - `<BuyerSnippet code />`, `<RetireButton apiId />`
  - `POST /api/apis/:apiId/retire` → 200 `{ state: "retired" }` | 409
  - Public page `/p/:apiId` (live APIs only)

- [ ] **Step 1: Write the failing tests**

`apps/web/lib/snippet.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildBuyerSnippet } from "./snippet";

const input = {
  gatewayBaseUrl: "https://api.hirakumi.app/", apiId: "api_1", packId: "pk_1", packCalls: 100,
  packPriceMicros: "2000000", opId: "getPrice", method: "GET",
};

describe("buildBuyerSnippet", () => {
  it("is a standard @x402/fetch client in under 20 lines (US6)", () => {
    const code = buildBuyerSnippet(input);
    expect(code.split("\n").length).toBeLessThanOrEqual(20);
    expect(code).toContain('import { wrapFetchWithPayment, x402Client } from "@x402/fetch";');
    expect(code).toContain("npm i @x402/fetch@2.26.0 @x402/cardano@2.26.0");
    expect(code).toContain('const base = "https://api.hirakumi.app/a/api_1";');
    expect(code).toContain("${base}/packs/pk_1");
    expect(code).toContain("${base}/x/getPrice");
    expect(code).toContain("Authorization: `Bearer ${token}`");
  });

  it("caps spending at exactly one pack, because the x402 client's default cap is $1", () => {
    expect(buildBuyerSnippet(input)).toContain('.setSpendControls({ maxAmountPerPayment: "$2" })');
    expect(buildBuyerSnippet({ ...input, packPriceMicros: "2500000" })).toContain('maxAmountPerPayment: "$2.5"');
  });

  it("sends a JSON body for non-GET operations", () => {
    const code = buildBuyerSnippet({ ...input, method: "POST", opId: "quote" });
    expect(code).toContain('method: "POST"');
    expect(code).toContain("body: JSON.stringify(input)");
    expect(code.split("\n").length).toBeLessThanOrEqual(20);
  });
});
```

`apps/web/lib/repo/overview-stats.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedCall, seedCreditToken, seedHealthEvent, seedJob, seedPack, seedSeller } from "@/test/factories";
import { getOverviewStats, listIncidents } from "./stats";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("overview stats", () => {
  beforeEach(resetDb);

  it("counts paid calls in the last 24 hours and the pass rate", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    for (let i = 0; i < 3; i++) await seedCall(api.id, { verdict: "pass" });
    await seedCall(api.id, { verdict: "fail" });
    await seedCall(api.id, { verdict: "pass", createdAt: minutesAgo(60 * 48) });
    await seedCall(api.id, { kind: "probe", verdict: "pass" });
    const s = await getOverviewStats(getSql(), api.id);
    expect(s).toMatchObject({ callsDay: 4, passDay: 3, failDay: 1, passRate: 0.75 });
  });

  it("has no pass rate before any paid call", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    expect((await getOverviewStats(getSql(), api.id)).passRate).toBeNull();
  });

  it("sums settled pack sales and escrow earnings net of Masumi's 5%", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id, { priceMicros: "2000000", escrowPriceMicros: "2000000" });
    await seedCreditToken(api.id, pack.id, { status: "active" });
    await seedCreditToken(api.id, pack.id, { status: "exhausted" });
    await seedCreditToken(api.id, pack.id, { status: "pending", txHash: null });
    for (let i = 0; i < 3; i++) await seedJob(api.id, { status: "completed" });
    await seedJob(api.id, { status: "failed" });
    const s = await getOverviewStats(getSql(), api.id);
    expect(s).toMatchObject({
      packSales: 2, packEarningsMicros: "4000000",
      escrowJobs: 3, escrowGrossMicros: "6000000", escrowFeeMicros: "300000", escrowNetMicros: "5700000",
    });
  });

  it("reports downtime with credits used and calls that didn't pass", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    await seedHealthEvent(api.id, "healthy", "down", minutesAgo(30), ["$.price is missing"]);
    await seedCall(api.id, { verdict: "fail", createdAt: minutesAgo(29) });
    await seedCall(api.id, { verdict: "n/a", execution: "blocked", createdAt: minutesAgo(28) });
    await seedHealthEvent(api.id, "down", "healthy", minutesAgo(20));
    await seedCall(api.id, { verdict: "pass", createdAt: minutesAgo(10) });
    await seedHealthEvent(api.id, "healthy", "down", minutesAgo(5));
    const incidents = await listIncidents(getSql(), api.id);
    expect(incidents).toHaveLength(2);
    expect(incidents[0]).toMatchObject({ upAt: null, creditsUsed: 0, callsNotPassed: 0 });
    expect(incidents[1]).toMatchObject({ creditsUsed: 0, callsNotPassed: 2, reasons: ["$.price is missing"] });
    expect(incidents[1].upAt).not.toBeNull();
  });
});
```

`apps/web/app/api/apis/[apiId]/retire/retire.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGatewayForTests, type Gateway } from "@/lib/gateway";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST } from "./route";

describe("POST /api/apis/:apiId/retire", () => {
  beforeEach(async () => {
    await resetDb();
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi: vi.fn(async () => undefined), getHealth: vi.fn() } as Gateway);
  });
  afterEach(() => setGatewayForTests(null));

  it("retires a live API", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const res = await POST(jsonRequest(`/api/apis/${api.id}/retire`, { cookie: cookieFor(seller), body: {} }), ctx(api.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "retired" });
  });

  it("refuses to retire an API that isn't live", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "registering");
    const res = await POST(jsonRequest(`/api/apis/${api.id}/retire`, { cookie: cookieFor(seller), body: {} }), ctx(api.id));
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run the tests (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/snippet.test.ts lib/repo/overview-stats.test.ts "app/api/apis/[apiId]/retire/retire.test.ts"`
Expected: FAIL, `Failed to resolve import "./snippet"`, `"./route"`, and `getOverviewStats is not a function` (or a missing export error).

- [ ] **Step 3: Write the stats additions, snippet and route**

Append to `apps/web/lib/repo/stats.ts`:
```ts
export type OverviewStats = {
  callsDay: number;
  passDay: number;
  failDay: number;
  passRate: number | null;
  packSales: number;
  packEarningsMicros: string;
  escrowJobs: number;
  escrowGrossMicros: string;
  escrowFeeMicros: string;
  escrowNetMicros: string;
};

const MASUMI_FEE_PERCENT = 5n;

export async function getOverviewStats(sql: Sql, apiId: string): Promise<OverviewStats> {
  const [calls] = await sql<{ callsDay: number; passDay: number; failDay: number }[]>`
    select count(*)::int as calls_day,
           count(*) filter (where verdict = 'pass')::int as pass_day,
           count(*) filter (where verdict = 'fail')::int as fail_day
    from calls
    where api_id = ${apiId} and kind in ('credit', 'escrow') and created_at > now() - interval '24 hours'`;
  const [packs] = await sql<{ packSales: number; packEarningsMicros: string }[]>`
    select count(*)::int as pack_sales, coalesce(sum(p.price_micros), 0)::text as pack_earnings_micros
    from credit_tokens t join packs p on p.id = t.pack_id
    where t.api_id = ${apiId} and t.status <> 'pending'`;
  const [escrow] = await sql<{ escrowJobs: number; escrowPriceMicros: string | null }[]>`
    select (select count(*)::int from jobs where api_id = ${apiId} and status = 'completed') as escrow_jobs,
           (select escrow_price_micros::text from packs where api_id = ${apiId} order by id limit 1) as escrow_price_micros`;
  const gross = BigInt(escrow.escrowJobs) * BigInt(escrow.escrowPriceMicros ?? "0");
  const fee = (gross * MASUMI_FEE_PERCENT) / 100n;
  const decided = calls.passDay + calls.failDay;
  return {
    callsDay: calls.callsDay,
    passDay: calls.passDay,
    failDay: calls.failDay,
    passRate: decided === 0 ? null : calls.passDay / decided,
    packSales: packs.packSales,
    packEarningsMicros: packs.packEarningsMicros,
    escrowJobs: escrow.escrowJobs,
    escrowGrossMicros: gross.toString(),
    escrowFeeMicros: fee.toString(),
    escrowNetMicros: (gross - fee).toString(),
  };
}

export type Incident = { downAt: Date; upAt: Date | null; reasons: unknown; creditsUsed: number; callsNotPassed: number };

/** Each down event, when it ended, and what paid calls did meanwhile (spec flow 4.6). */
export async function listIncidents(sql: Sql, apiId: string, limit = 5): Promise<Incident[]> {
  return sql<Incident[]>`
    select d.at as down_at, d.reasons, u.up_at, c.credits_used, c.calls_not_passed
    from health_events d
    left join lateral (
      select min(h.at) as up_at from health_events h
      where h.api_id = d.api_id and h.to_health = 'healthy' and h.at > d.at
    ) u on true
    left join lateral (
      select count(*) filter (where k.kind = 'credit' and k.verdict = 'pass')::int as credits_used,
             count(*) filter (where k.kind in ('credit', 'escrow')
                                and (k.verdict = 'fail' or k.execution <> 'upstream_ok'))::int as calls_not_passed
      from calls k
      where k.api_id = d.api_id and k.created_at >= d.at and k.created_at < coalesce(u.up_at, now())
    ) c on true
    where d.api_id = ${apiId} and d.to_health = 'down'
    order by d.at desc
    limit ${limit}`;
}
```

`apps/web/lib/snippet.ts`:
```ts
import { formatTusdm } from "./money";

export type SnippetInput = {
  gatewayBaseUrl: string;
  apiId: string;
  packId: string;
  packCalls: number;
  packPriceMicros: string;
  opId: string;
  method: string;
};

/** Buyer integration in under 20 lines with the standard x402 client (US6). Strings are single-quoted on purpose: the output contains template literals. */
export function buildBuyerSnippet(i: SnippetInput): string {
  const price = formatTusdm(i.packPriceMicros);
  const base = `${i.gatewayBaseUrl.replace(/\/+$/, "")}/a/${i.apiId}`;
  const method = i.method.toUpperCase();
  const isGet = method === "GET";
  const callInit = isGet
    ? '{ headers: { Authorization: `Bearer ${token}` } }'
    : '{ method: "' + method + '", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) }';
  return [
    "// npm i @x402/fetch@2.26.0 @x402/cardano@2.26.0",
    'import { wrapFetchWithPayment, x402Client } from "@x402/fetch";',
    'import { toClientCardanoSigner } from "@x402/cardano";',
    'import { ExactCardanoScheme } from "@x402/cardano/exact/client";',
    "",
    `const base = "${base}";`,
    'const signer = toClientCardanoSigner({ mnemonic: process.env.MNEMONIC!, network: "cardano:preprod",',
    '  provider: { blockfrost: { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId: process.env.BLOCKFROST_PROJECT_ID } } });',
    'const client = new x402Client().register("cardano:preprod", new ExactCardanoScheme(signer))',
    `  .setSpendControls({ maxAmountPerPayment: "$${price}" }); // never pay more than one pack`,
    "const payFetch = wrapFetchWithPayment(fetch, client);",
    `// one payment buys ${i.packCalls} credits for ${price} tUSDM`,
    'const { token } = await (await payFetch(`${base}/packs/' + i.packId + '`, { method: "POST" })).json();',
    ...(isGet ? [] : ["const input = {}; // your request body"]),
    "// 200 uses one credit; 422 means the promise wasn't met and no credit was used",
    'const res = await fetch(`${base}/x/' + i.opId + "`, " + callInit + ");",
    'console.log(res.status, res.headers.get("x-credits-remaining"), await res.json());',
  ].join("\n");
}
```

`apps/web/app/api/apis/[apiId]/retire/route.ts`:
```ts
import { reloadQuietly } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { transitionState } from "@/lib/repo/apis";
import { loadOwnedApi } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  const moved = await transitionState(sql, { apiId: api.id, sellerId: session.sellerId, from: ["live"], to: "retired" });
  if (!moved) return errorJson(409, "Only a live API can be removed from the market.");
  await reloadQuietly(api.id);
  return json({ state: "retired" });
}
```

- [ ] **Step 4: Run the tests (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run lib/snippet.test.ts lib/repo/overview-stats.test.ts "app/api/apis/[apiId]/retire/retire.test.ts"`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the components and pages**

`apps/web/components/buyer-snippet.tsx`:
```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function BuyerSnippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs"><code>{code}</code></pre>
      <Button variant="outline" onClick={copy}>{copied ? "Copied" : "Copy code"}</Button>
    </div>
  );
}
```

`apps/web/components/retire-button.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";

export function RetireButton({ apiId }: { apiId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function retire() {
    if (!window.confirm("Remove this API from the agent market? New sales stop. This can't be undone.")) return;
    try {
      await postJson(`/api/apis/${apiId}/retire`, {});
      router.refresh();
    } catch (e) {
      setError(e instanceof RequestError ? e.message : "Something went wrong. Try again.");
    }
  }
  return (
    <div className="space-y-1">
      <Button variant="destructive" onClick={retire}>Remove from the market</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
```

`apps/web/app/apis/[apiId]/overview/page.tsx`:
```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { BuyerSnippet } from "@/components/buyer-snippet";
import { HealthBadge } from "@/components/health-badge";
import { RetireButton } from "@/components/retire-button";
import { PackSalesTable } from "@/components/sales-tables";
import { EmptyState, WaitingState } from "@/components/states";
import { StepList } from "@/components/step-list";
import { formatTime } from "@/lib/copy";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { stepForState } from "@/lib/flow";
import { getGateway } from "@/lib/gateway";
import { formatTusdm } from "@/lib/money";
import { loadApiPage } from "@/lib/page-auth";
import { listOnboardSteps } from "@/lib/repo/apis";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";
import { getOverviewStats, listIncidents, listPackSales } from "@/lib/repo/stats";
import { buildBuyerSnippet } from "@/lib/snippet";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function stringReasons(r: unknown): string[] {
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
}

export default async function OverviewPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/overview`);
  if (api.state !== "registering" && api.state !== "live" && api.state !== "retired") {
    redirect(`/apis/${apiId}/${stepForState(api.state)}`);
  }
  const sql = getSql();
  const [stats, incidents, pack, promises, sales, steps] = await Promise.all([
    getOverviewStats(sql, apiId), listIncidents(sql, apiId), getPack(sql, apiId),
    listLatestRules(sql, apiId), listPackSales(sql, apiId, 5), listOnboardSteps(sql, apiId),
  ]);
  const downReasons = api.state === "live" && api.health === "down"
    ? await getGateway().getHealth(apiId).then((h) => h.lastReasons).catch(() => [])
    : [];
  const publicBase = env.publicBaseUrl();
  const buyerBase = `${publicBase}/a/${apiId}`;
  const snippetOp = promises.find((p) => p.opId === api.escrowOpId) ?? promises[0];

  return (
    <section className="space-y-8">
      <AutoRefresh everyMs={5000} />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{api.name}</h1>
        <HealthBadge state={api.state} health={api.health} checkedAt={api.healthCheckedAt} />
      </div>

      {api.state === "registering" && (
        <WaitingState title="Registering on the Masumi network. This takes about a minute."
          detail="Your API goes Live as soon as the registry lists it.">
          <StepList steps={steps} />
        </WaitingState>
      )}
      {downReasons.length > 0 && (
        <div role="alert" className="rounded-lg border border-destructive/50 p-4 text-sm">
          <p className="font-medium">Your API is Down. Buyers get a "try later" answer and no credits are used.</p>
          <ul className="list-disc pl-5">{downReasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      <dl className="grid gap-2 text-sm sm:grid-cols-[180px_1fr]">
        <dt className="text-muted-foreground">Agent ID</dt><dd className="break-all">{api.agentIdentifier ?? "Assigned after registration"}</dd>
        <dt className="text-muted-foreground">Buyer URL</dt><dd className="break-all">{buyerBase}</dd>
        <dt className="text-muted-foreground">Health check URL</dt><dd className="break-all">{`${buyerBase}/availability`}</dd>
        {promises.map((p) => (
          <div key={p.operationId} className="contents">
            <dt className="text-muted-foreground">{`Promise for ${p.method.toUpperCase()} ${p.path}`}</dt>
            <dd className="break-all">{`${publicBase}/r/${p.hash}`}</dd>
          </div>
        ))}
        {api.state === "live" && (<><dt className="text-muted-foreground">Public page</dt><dd><Link href={`/p/${apiId}`} className="underline">{`/p/${apiId}`}</Link></dd></>)}
      </dl>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Paid calls, last 24 hours" value={String(stats.callsDay)} />
        <Stat label="Kept the promise" value={stats.passRate === null ? "No paid calls yet" : `${Math.round(stats.passRate * 100)}%`}
          note={`${stats.passDay} passed, ${stats.failDay} didn't (no credit used)`} />
        <Stat label="Pack earnings" value={`${formatTusdm(stats.packEarningsMicros)} tUSDM`} note={`${stats.packSales} packs sold`} />
        <Stat label="Per-job earnings" value={`${formatTusdm(stats.escrowNetMicros)} tUSDM`}
          note={`${stats.escrowJobs} jobs, ${formatTusdm(stats.escrowGrossMicros)} paid, Masumi kept ${formatTusdm(stats.escrowFeeMicros)}`} />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Latest pack sales</h2>
          <Link href={`/apis/${apiId}/sales`} className="text-sm underline">See all sales</Link>
        </div>
        <PackSalesTable sales={sales} />
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">Downtime</h2>
        {incidents.length === 0 ? (
          <EmptyState title="No downtime recorded" detail="If your API stops keeping its promise, Hirakumi marks it Down and tells you here." />
        ) : (
          <ul className="space-y-3">
            {incidents.map((i) => (
              <li key={new Date(i.downAt).toISOString()} className="rounded-lg border p-4 text-sm">
                <p className="font-medium">{`Down from ${formatTime(i.downAt)} ${i.upAt ? `to ${formatTime(i.upAt)}` : "until now"}`}</p>
                <p>{`${i.creditsUsed} credits used while Down. ${i.callsNotPassed} paid calls didn't pass and used no credits.`}</p>
                <ul className="list-disc pl-5 text-muted-foreground">{stringReasons(i.reasons).map((r) => <li key={r}>{r}</li>)}</ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">For agent builders</h2>
        {pack && snippetOp ? (
          <BuyerSnippet code={buildBuyerSnippet({
            gatewayBaseUrl: publicBase, apiId, packId: pack.id, packCalls: pack.calls,
            packPriceMicros: pack.priceMicros, opId: snippetOp.opId, method: snippetOp.method,
          })} />
        ) : (
          <EmptyState title="No buyer code yet" detail="The code appears once your API has a price and a promise." />
        )}
      </div>

      {api.state === "live" && <RetireButton apiId={apiId} />}
    </section>
  );
}
```

`apps/web/app/p/[apiId]/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { BuyerSnippet } from "@/components/buyer-snippet";
import { HealthBadge } from "@/components/health-badge";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { formatTusdm } from "@/lib/money";
import { getLiveApi } from "@/lib/repo/apis";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";
import { buildBuyerSnippet } from "@/lib/snippet";

export default async function PublicApiPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const sql = getSql();
  const api = await getLiveApi(sql, apiId);
  if (!api) notFound();
  const [pack, promises] = await Promise.all([getPack(sql, apiId), listLatestRules(sql, apiId)]);
  const op = promises.find((p) => p.opId === api.escrowOpId) ?? promises[0];
  const publicBase = env.publicBaseUrl();
  return (
    <section className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold">{api.name}</h1>
        <HealthBadge state={api.state} health={api.health} checkedAt={api.healthCheckedAt} />
      </div>
      {pack && <p>{`${pack.calls} credits for ${formatTusdm(pack.priceMicros)} tUSDM, paid once on Cardano preprod. A credit is used only when the response keeps the promise.`}</p>}
      <ul className="space-y-2">
        {promises.map((p) => (
          <li key={p.operationId} className="rounded-lg border p-4">
            <p className="font-mono text-sm">{p.method.toUpperCase()} {p.path}</p>
            <p>{p.plainEnglish ?? "See the exact check below."}</p>
            <a href={`${publicBase}/r/${p.hash}`} className="text-sm underline">The exact check (JSON)</a>
          </li>
        ))}
      </ul>
      {pack && op && (
        <BuyerSnippet code={buildBuyerSnippet({
          gatewayBaseUrl: publicBase, apiId, packId: pack.id, packCalls: pack.calls,
          packPriceMicros: pack.priceMicros, opId: op.opId, method: op.method,
        })} />
      )}
    </section>
  );
}
```

- [ ] **Step 6: Run the full suite and the build (expect PASS)**

Run: `pnpm --filter @hirakumi/web test && pnpm --filter @hirakumi/web build`
Expected: all tests PASS and the build lists `/apis/[apiId]/overview`, `/apis/[apiId]/sales` and `/p/[apiId]`.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): API overview with health, pass rate, earnings, downtime and buyer snippet; public page; retire" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Dashboard chat panel (coworker fallback)

> **Contract v1.1 override:** do **not** create `db/migrations/0002_chat.sql`. The shared chat table is `messages`, created by P3's `0002_coworker.sql`, and it has every column this task uses (`seller_id`, `api_id`, `author`, `body`, `created_at`, `handled_at`). Wherever this task says `messages`, use `messages`. Skip the migration step; if P3's migration hasn't landed yet, apply P3's `0002_coworker.sql` locally first.

Build this only if the hour-2 gate says Sokosumi whitelisting failed. Otherwise leave `CHAT_FALLBACK` unset; the code stays dormant.

**Files:**
- Create: `db/migrations/0002_chat.sql`, `apps/web/lib/repo/chat.ts`, `apps/web/app/api/chat/route.ts`, `apps/web/components/chat-panel.tsx`
- Modify: `apps/web/app/apis/[apiId]/layout.tsx`, `apps/web/app/apis/new/page.tsx`
- Test: `apps/web/app/api/chat/chat.test.ts`, `apps/web/components/chat-panel.test.tsx`

**Interfaces:**
- Consumes: `requireSeller`, `json`, `errorJson`, `readJson` (Task 4); `getApiForSeller` (Task 7); `env.chatFallback()` (Task 2); `getJson`, `postJson`, `RequestError` (Task 6).
- Produces (contract addition A1):
  - Table `messages(id bigserial, seller_id, api_id null, author 'seller'|'coworker', body, created_at, handled_at)`
  - `type ChatMessage = { id: string; apiId: string | null; author: "seller" | "coworker"; body: string; createdAt: Date }`; `listChat(sql, sellerId, apiId: string | null, afterId: number): Promise<ChatMessage[]>`; `postSellerMessage(sql, sellerId, apiId: string | null, body: string): Promise<ChatMessage>`
  - `GET /api/chat?apiId=&after=` → 200 `{ messages: ChatMessage[] }`; `POST /api/chat` body `{ apiId?: string | null, body: string }` → 201 `{ message }`; both → 404 when `CHAT_FALLBACK` is off
  - `<ChatPanel apiId: string | null />`
  - For P3: poll `select … from messages where author = 'seller' and handled_at is null order by id`, insert replies with `author = 'coworker'` and the same `seller_id`/`api_id`, then `update messages set handled_at = now() where id = $1`.

- [ ] **Step 1: Write the migration**

`db/migrations/0002_chat.sql`:
```sql
-- 0002_chat.sql (owned by P2; contract addition A1)
-- Dashboard chat, used as the coworker channel when Sokosumi whitelisting is unavailable.
create table messages (
  id bigserial primary key,
  seller_id text not null references sellers(id),
  api_id text references apis(id),
  author text not null check (author in ('seller', 'coworker')),
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
create index messages_thread on messages (seller_id, api_id, id);
create index messages_unhandled on messages (id) where author = 'seller' and handled_at is null;
```

- [ ] **Step 2: Write the failing tests**

`apps/web/app/api/chat/chat.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, jsonRequest } from "@/test/requests";
import { GET, POST } from "./route";

describe("/api/chat", () => {
  beforeEach(resetDb);
  afterEach(() => {
    process.env.CHAT_FALLBACK = "1";
  });

  it("stores the seller's message and lists the thread after a cursor", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id);
    const cookie = cookieFor(seller);
    const posted = await POST(jsonRequest("/api/chat", { cookie, body: { apiId: api.id, body: "  Is my file right?  " } }));
    expect(posted.status).toBe(201);
    const { message } = (await posted.json()) as { message: { id: string; body: string; author: string } };
    expect(message).toMatchObject({ body: "Is my file right?", author: "seller" });
    await getSql()`
      insert into messages (seller_id, api_id, author, body) values (${seller.id}, ${api.id}, 'coworker', 'Yes, it matches.')`;
    const res = await GET(jsonRequest(`/api/chat?apiId=${api.id}&after=${message.id}`, { cookie }));
    const { messages } = (await res.json()) as { messages: { author: string; body: string }[] };
    expect(messages).toEqual([expect.objectContaining({ author: "coworker", body: "Yes, it matches." })]);
  });

  it("keeps threads per API", async () => {
    const seller = await seedSeller();
    const a = await seedApi(seller.id, "intake", { openapiUrl: "https://a.example/openapi.json" });
    const b = await seedApi(seller.id, "intake", { openapiUrl: "https://b.example/openapi.json" });
    const cookie = cookieFor(seller);
    await POST(jsonRequest("/api/chat", { cookie, body: { apiId: a.id, body: "about A" } }));
    const res = await GET(jsonRequest(`/api/chat?apiId=${b.id}&after=0`, { cookie }));
    expect(((await res.json()) as { messages: unknown[] }).messages).toEqual([]);
  });

  it("returns 404 for another seller's API", async () => {
    const owner = await seedSeller();
    const api = await seedApi(owner.id);
    const intruder = await seedSeller();
    const res = await POST(jsonRequest("/api/chat", { cookie: cookieFor(intruder), body: { apiId: api.id, body: "hi" } }));
    expect(res.status).toBe(404);
  });

  it("refuses an empty message", async () => {
    const seller = await seedSeller();
    const res = await POST(jsonRequest("/api/chat", { cookie: cookieFor(seller), body: { apiId: null, body: "   " } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Write a message first." });
  });

  it("is off unless CHAT_FALLBACK=1", async () => {
    process.env.CHAT_FALLBACK = "0";
    const seller = await seedSeller();
    const res = await GET(jsonRequest("/api/chat?after=0", { cookie: cookieFor(seller) }));
    expect(res.status).toBe(404);
  });
});
```

`apps/web/components/chat-panel.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { ChatPanel } from "./chat-panel";

afterEach(() => vi.unstubAllGlobals());

describe("ChatPanel", () => {
  it("shows the empty state, then the conversation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatPanel apiId="api_1" />);
    expect(await screen.findByText("Ask the Hirakumi coworker anything about listing your API. Replies appear here.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/chat?after=0&apiId=api_1");
  });

  it("renders who said what", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ messages: [
      { id: "1", apiId: "api_1", author: "seller", body: "Hello", createdAt: "2026-10-06T10:00:00Z" },
      { id: "2", apiId: "api_1", author: "coworker", body: "Found 6 endpoints, 2 look sellable.", createdAt: "2026-10-06T10:00:05Z" },
    ] })));
    render(<ChatPanel apiId="api_1" />);
    expect(await screen.findByText("Found 6 endpoints, 2 look sellable.")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Hirakumi coworker")).toBeInTheDocument();
  });

  it("sends a message and shows it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({ message: { id: "9", apiId: "api_1", author: "seller", body: "Help", createdAt: "2026-10-06T10:00:00Z" } }, 201)
        : jsonResponse({ messages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ChatPanel apiId="api_1" />);
    await user.type(screen.getByLabelText("Message"), "Help");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Help")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ apiId: "api_1", body: "Help" });
  });

  it("says when messages can't be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    render(<ChatPanel apiId={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't load messages. Retrying…");
  });
});
```

- [ ] **Step 3: Run the tests (expect FAIL)**

Run: `pnpm --filter @hirakumi/web exec vitest run app/api/chat/chat.test.ts components/chat-panel.test.tsx`
Expected: FAIL, `Failed to resolve import "./route"` and `"./chat-panel"`. (The global setup re-applies all migrations, so `0002_chat.sql` is already in the test database.)

- [ ] **Step 4: Write the repo, route and panel**

`apps/web/lib/repo/chat.ts`:
```ts
import type { Sql } from "../db";

export type ChatMessage = { id: string; apiId: string | null; author: "seller" | "coworker"; body: string; createdAt: Date };

export async function listChat(sql: Sql, sellerId: string, apiId: string | null, afterId: number): Promise<ChatMessage[]> {
  return sql<ChatMessage[]>`
    select id::text as id, api_id, author, body, created_at from messages
    where seller_id = ${sellerId}
      and ${apiId === null ? sql`api_id is null` : sql`api_id = ${apiId}`}
      and id > ${afterId}
    order by id asc limit 200`;
}

export async function postSellerMessage(sql: Sql, sellerId: string, apiId: string | null, body: string): Promise<ChatMessage> {
  const [row] = await sql<ChatMessage[]>`
    insert into messages (seller_id, api_id, author, body) values (${sellerId}, ${apiId}, 'seller', ${body})
    returning id::text as id, api_id, author, body, created_at`;
  return row;
}
```

`apps/web/app/api/chat/route.ts`:
```ts
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { errorJson, json, readJson, requireSeller } from "@/lib/http";
import { getApiForSeller } from "@/lib/repo/apis";
import { listChat, postSellerMessage } from "@/lib/repo/chat";

const OFF = () => errorJson(404, "Chat is turned off.");

async function ownsApi(apiId: string | null, sellerId: string): Promise<boolean> {
  return apiId === null || (await getApiForSeller(getSql(), apiId, sellerId)) !== null;
}

export async function GET(req: Request): Promise<Response> {
  if (!env.chatFallback()) return OFF();
  const session = requireSeller(req);
  if (session instanceof Response) return session;
  const params = new URL(req.url).searchParams;
  const apiId = params.get("apiId");
  const after = Number(params.get("after") ?? "0");
  if (!Number.isSafeInteger(after) || after < 0) return errorJson(400, "Reload the page.");
  if (!(await ownsApi(apiId, session.sellerId))) return errorJson(404, "We couldn't find that API in your account.");
  return json({ messages: await listChat(getSql(), session.sellerId, apiId, after) });
}

export async function POST(req: Request): Promise<Response> {
  if (!env.chatFallback()) return OFF();
  const session = requireSeller(req);
  if (session instanceof Response) return session;
  const body = await readJson(req);
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text) return errorJson(400, "Write a message first.");
  if (text.length > 4000) return errorJson(400, "Keep messages under 4,000 characters.");
  const apiId = typeof body?.apiId === "string" ? body.apiId : null;
  if (!(await ownsApi(apiId, session.sellerId))) return errorJson(404, "We couldn't find that API in your account.");
  return json({ message: await postSellerMessage(getSql(), session.sellerId, apiId, text) }, 201);
}
```

`apps/web/components/chat-panel.tsx`:
```tsx
"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { getJson, postJson, RequestError } from "@/lib/client-fetch";

type Msg = { id: string; author: "seller" | "coworker"; body: string; createdAt: string };

function merge(prev: Msg[], incoming: Msg[]): Msg[] {
  const seen = new Set(prev.map((m) => m.id));
  return [...prev, ...incoming.filter((m) => !seen.has(m.id))];
}

export function ChatPanel({ apiId }: { apiId: string | null }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const lastId = useRef("0");
  const query = apiId ? `&apiId=${encodeURIComponent(apiId)}` : "";

  const load = useCallback(async () => {
    try {
      const data = await getJson<{ messages: Msg[] }>(`/api/chat?after=${lastId.current}${query}`);
      if (data.messages.length > 0) {
        lastId.current = data.messages[data.messages.length - 1].id;
        setMessages((prev) => merge(prev, data.messages));
      }
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [query]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setSendError(null);
    try {
      const data = await postJson<{ message: Msg }>("/api/chat", { apiId, body: text });
      setDraft("");
      setMessages((prev) => merge(prev, [data.message]));
    } catch (err) {
      setSendError(err instanceof RequestError ? err.message : "Your message wasn't sent. Try again.");
    }
  }

  return (
    <section aria-label="Chat with the Hirakumi coworker" className="space-y-3 rounded-lg border p-4">
      <h2 className="font-medium">Chat with Hirakumi</h2>
      {loadError && <p role="alert" className="text-sm text-destructive">We couldn't load messages. Retrying…</p>}
      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ask the Hirakumi coworker anything about listing your API. Replies appear here.</p>
      ) : (
        <ul className="max-h-96 space-y-2 overflow-y-auto text-sm">
          {messages.map((m) => (
            <li key={m.id}>
              <span className="text-xs text-muted-foreground">{m.author === "seller" ? "You" : "Hirakumi coworker"}</span>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={send} className="space-y-2">
        <label htmlFor="chat-draft" className="sr-only">Message</label>
        <textarea id="chat-draft" rows={3} className="w-full rounded-md border p-2 text-sm" value={draft}
          onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" disabled={!draft.trim()}>Send</Button>
        {sendError && <p role="alert" className="text-sm text-destructive">{sendError}</p>}
      </form>
    </section>
  );
}
```

Replace `apps/web/app/apis/[apiId]/layout.tsx`:
```tsx
import type { ReactNode } from "react";
import { ApiNav } from "@/components/api-nav";
import { ChatPanel } from "@/components/chat-panel";
import { env } from "@/lib/env";

export default async function ApiLayout({ children, params }: { children: ReactNode; params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const chat = env.chatFallback();
  return (
    <div className={chat ? "grid gap-8 lg:grid-cols-[1fr_320px]" : ""}>
      <div className="space-y-6">
        <ApiNav apiId={apiId} />
        {children}
      </div>
      {chat && <aside><ChatPanel apiId={apiId} /></aside>}
    </div>
  );
}
```

In `apps/web/app/apis/new/page.tsx`, add the imports and render the panel after `<SetupForm … />`:
```tsx
import { ChatPanel } from "@/components/chat-panel";
import { env } from "@/lib/env";
```
```tsx
      {env.chatFallback() && <ChatPanel apiId={null} />}
```

- [ ] **Step 5: Run the tests (expect PASS)**

Run: `pnpm --filter @hirakumi/web exec vitest run app/api/chat/chat.test.ts components/chat-panel.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0002_chat.sql apps/web
git commit -m "feat(web): dashboard chat panel as the coworker fallback (migration 0002_chat)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Tell the team**

Post in team chat: "Contract addition A1: `db/migrations/0002_chat.sql` adds `messages`. P3: poll `author='seller' and handled_at is null`, reply with `author='coworker'`, set `handled_at`. P4: apply 0002 on EC2 Postgres."

### Task 16: Deploy to Vercel and run the full flow with a real wallet (hour-18 checkpoint)

**Files:**
- Modify: none (configuration only). `apps/web/vercel.json` already pins region `sin1`.

**Interfaces:**
- Consumes: EC2 Postgres reachable from Vercel (P4, contract addition A5); gateway `/internal/*` behind Caddy at `GATEWAY_INTERNAL_URL` (P1/P4); coworker advancing states (P3); demo seller `sellers/price-api` serving `/.well-known/hirakumi/<apiId>.txt` (P5).
- Produces: production URL `WEB_BASE_URL` (P3 puts it in the Sokosumi setup link: `${WEB_BASE_URL}/apis/new?openapiUrl=<url>`).

- [ ] **Step 1: Run the whole suite locally**

Run: `pnpm --filter @hirakumi/web test && pnpm --filter @hirakumi/web typecheck && pnpm --filter @hirakumi/web build`
Expected: all PASS, no type errors, build succeeds.

- [ ] **Step 2: Link the project**

Run from the repo root: `vercel link --yes --project hirakumi-web`
Then in the Vercel dashboard, open Project Settings → Build and Deployment and set **Root Directory** to `apps/web`. Leave the install command at its default, which detects the pnpm workspace from the root lockfile. Verify with `vercel pull --yes --environment=production && cat .vercel/project.json`.
Expected: `"rootDirectory": "apps/web"` appears in the project settings.

- [ ] **Step 3: Set production environment variables**

Run each line, substituting real values (`SESSION_SECRET` from `openssl rand -hex 32`; `DATABASE_URL` must end with `?sslmode=require`):
```bash
printf '%s' "$PROD_DATABASE_URL" | vercel env add DATABASE_URL production
printf '%s' "$(openssl rand -hex 32)" | vercel env add SESSION_SECRET production
printf '%s' "$INTERNAL_TOKEN" | vercel env add INTERNAL_TOKEN production
printf '%s' "https://api.hirakumi.app" | vercel env add PUBLIC_BASE_URL production
printf '%s' "https://api.hirakumi.app" | vercel env add GATEWAY_INTERNAL_URL production
printf '%s' "https://hirakumi.vercel.app" | vercel env add WEB_BASE_URL production
printf '%s' "0" | vercel env add ALLOW_INSECURE_UPSTREAM production
printf '%s' "$CHAT_FALLBACK" | vercel env add CHAT_FALLBACK production
printf '%s' "$ESCROW_SWEEP_NOTICE" | vercel env add ESCROW_SWEEP_NOTICE production
```
Expected: `vercel env ls production` lists all nine. `WEB_BASE_URL` must be the exact production domain, because it is signed into every login and ownership message.

- [ ] **Step 4: Deploy**

Run: `vercel deploy --prod`
Expected: `Production: https://hirakumi.vercel.app` (or the assigned domain).

- [ ] **Step 5: Smoke-check without a wallet**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://hirakumi.vercel.app/login
curl -s -X POST https://hirakumi.vercel.app/api/auth/nonce -H 'content-type: application/json' -d "{\"address\":\"$SELLER_DEMO_ADDRESS\"}"
```
Expected: `200`, then JSON with `"message":"Sign in to Hirakumi\n…Site: hirakumi.vercel.app…"`. If you get a 500, run `vercel logs` and check for `Missing environment variable` or a Mesh/libsodium load error.

- [ ] **Step 6: Full flow with Eternl on preprod (hour-18 gate)**

With P1's gateway, P3's coworker and P5's price-api live: sign in, then paste the price-api OpenAPI URL on `/apis/new`. Wait for the coworker to list endpoints, tick `GET /price`, choose it for per-job hires, and confirm. Download the challenge file and give it to P5 to serve, then click Check and sign. Wait for test calls, save a price of 100 calls for 2 tUSDM, and Publish.
Expected: the overview shows "Registering…" and then **Live** within about a minute, with the agent ID filled in. Run the P5 buyer, and the Sales table shows a pack with a working Cardanoscan link. Trigger the break switch, and within about 20 seconds the overview shows **Down** with the failing field and a downtime entry showing "0 credits used while Down".
Record any step that fails in team chat with the exact on-screen message.

- [ ] **Step 7: Commit the lockfile or settings changes, if any**

```bash
git add -A apps/web pnpm-lock.yaml
git commit -m "chore(web): production deployment settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17 (optional): Playwright smoke test of the happy path

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/env.ts`, `apps/web/e2e/global-setup.ts`, `apps/web/e2e/happy-path.spec.ts`

**Interfaces:**
- Consumes: `resetDatabase` (Task 2); `startMockGateway` (Task 8); `fakeParse`, `fakeBuildRules` (Task 8); `makeTestWallet` with `signHex` (Task 5).
- Produces: `pnpm --filter @hirakumi/web e2e`.

- [ ] **Step 1: Write the config, setup and spec**

`apps/web/e2e/env.ts`:
```ts
export const E2E_PORT = 3100;
export const E2E_GATEWAY_PORT = 4998;
export const E2E_INTERNAL_TOKEN = "e2e-internal-token";
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi_web_e2e";
```

`apps/web/e2e/global-setup.ts`:
```ts
import { startMockGateway } from "../scripts/mock-gateway";
import { resetDatabase } from "../test/global-setup";
import { E2E_DATABASE_URL, E2E_GATEWAY_PORT, E2E_INTERNAL_TOKEN } from "./env";

export default async function globalSetup(): Promise<() => Promise<void>> {
  await resetDatabase(E2E_DATABASE_URL);
  const server = await startMockGateway(E2E_GATEWAY_PORT, E2E_INTERNAL_TOKEN, { challengeOk: true });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}
```

`apps/web/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";
import { E2E_DATABASE_URL, E2E_GATEWAY_PORT, E2E_INTERNAL_TOKEN, E2E_PORT } from "./e2e/env";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: `http://localhost:${E2E_PORT}` },
  webServer: {
    command: `pnpm exec next dev --port ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
      INTERNAL_TOKEN: E2E_INTERNAL_TOKEN,
      GATEWAY_INTERNAL_URL: `http://127.0.0.1:${E2E_GATEWAY_PORT}`,
      PUBLIC_BASE_URL: "https://api.hirakumi.test",
      WEB_BASE_URL: `http://localhost:${E2E_PORT}`,
      ALLOW_INSECURE_UPSTREAM: "0",
      CHAT_FALLBACK: "0",
    },
  },
});
```

`apps/web/e2e/happy-path.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { fakeBuildRules, fakeParse } from "../scripts/dev-coworker";
import { makeTestWallet } from "../test/wallet-fixture";
import { E2E_DATABASE_URL } from "./env";

test("a seller goes from Setup to Publish", async ({ page }) => {
  const wallet = await makeTestWallet();
  const sql = postgres(E2E_DATABASE_URL, { max: 1 });
  try {
    // A CIP-30 wallet whose signData runs in Node with a real key, so the server verifies a real COSE signature.
    await page.exposeFunction("__hkSign", (payloadHex: string) => wallet.signHex(payloadHex));
    await page.addInitScript(({ addressHex }) => {
      const w = window as unknown as { __hkSign(hex: string): Promise<{ signature: string; key: string }>; cardano: unknown };
      const api = {
        getNetworkId: async () => 0,
        getChangeAddress: async () => addressHex,
        getUsedAddresses: async () => [addressHex],
        signData: async (_addr: string, payloadHex: string) => w.__hkSign(payloadHex),
      };
      w.cardano = { e2e: { name: "E2E Wallet", icon: "", enable: async () => api } };
    }, { addressHex: wallet.addressHex });

    await page.goto("/login?next=/apis/new");
    await page.getByRole("button", { name: "Sign in with E2E Wallet" }).click();
    await page.waitForURL("**/apis/new");

    await page.getByLabel("OpenAPI link").fill("https://price.example.dev/openapi.json");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/apis\/[^/]+\/endpoints$/);
    const apiId = new URL(page.url()).pathname.split("/")[2];
    await expect(page.getByText("Reading your API description")).toBeVisible();

    await fakeParse(sql, apiId);
    await page.getByLabel("Sell GET /price").check();
    await page.getByLabel("Use GET /price for per-job hires").check();
    await page.getByRole("button", { name: "Confirm endpoints" }).click();
    await page.waitForURL(`**/apis/${apiId}/ownership`);

    await page.getByRole("button", { name: "Check" }).click();
    await expect(page.getByText("Found it. Your file matches.")).toBeVisible();
    await page.getByRole("button", { name: "Sign with E2E Wallet" }).click();
    await page.waitForURL(`**/apis/${apiId}/review`);

    await fakeBuildRules(sql, apiId);
    await page.getByRole("button", { name: "Save price" }).click();
    await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();
    await page.getByRole("button", { name: "Publish" }).click();
    await page.waitForURL(`**/apis/${apiId}/overview`);
    await expect(page.getByRole("status").filter({ hasText: "This takes about a minute" })).toBeVisible();

    const [row] = await sql<{ state: string }[]>`select state from apis where id = ${apiId}`;
    expect(row.state).toBe("registering");
  } finally {
    await sql.end();
  }
});
```

- [ ] **Step 2: Run it (expect FAIL first, then PASS)**

Run: `pnpm --filter @hirakumi/web exec playwright install chromium && pnpm --filter @hirakumi/web e2e`
Expected: the first run before Step 1's files exist reports `No tests found`. With the files in place, the run reports `1 passed`. If it times out at "Reading your API description", the dev server is still compiling; rerun once.

- [ ] **Step 3: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/e2e
git commit -m "test(web): Playwright happy path with a software CIP-30 wallet and mock gateway" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (screens and stories → tasks):**

| Spec item | Where |
|---|---|
| Setup: paste OpenAPI URL → seller + API in `intake` (flow 1.2) | Task 6 creates the seller at sign-in; Task 7 creates the API (`POST /api/apis`, `SetupForm`) |
| Endpoints: tick, confirm no side effects, choose escrow op → `endpoints_confirmed` (flow 1.3, §5.4) | Task 9 |
| Ownership: download file, Check shows exact URL tried and error, wallet signs `buildWalletChallenge` → `ownership_verified` (flow 1.4–1.5, §5.5, US2) | Tasks 10 and 11 |
| Test calls with live progress (flow 1.6) | Task 12 Review page waiting state with `StepList` and `AutoRefresh` |
| Review: promise in plain English with JSON underneath, overridable price, suggested 100 calls / 2 tUSDM, escrow price → `priced`; Publish → `registering` (flow 1.7, US3, §5.7) | Task 12 |
| Live: agent ID, URLs, Online badge, buyer snippet (flow 1.8, US6) | Task 14 (overview + `/p/:apiId`, snippet ≤ 20 lines with `@x402/fetch`) |
| API overview: health, calls, pass rate, earnings with Cardanoscan links (US5) | Tasks 13 and 14 |
| Down within 30s on dashboard; downtime, "0 credits consumed", calls refused (US4, flow 4.6) | Task 14 (`AutoRefresh` 5s, `HealthBadge`, `listIncidents`, gateway `lastReasons`) |
| Stale monitor warning after 10 minutes (§11 Monitoring) | Task 7 `HealthBadge` + Task 3 `isStale` |
| Escrow earnings note when the payout spike fails (§6.2.5) and Masumi 5% shown (§9) | Task 13 (`ESCROW_SWEEP_NOTICE`), Tasks 12 and 14 |
| Dashboard chat fallback (§4, §11 Security last bullet) | Task 15 |
| Empty and error state per screen (§3 Screens) | Setup: form error. Endpoints: waiting, failed-step error, no-operations empty. Ownership: check failure, gateway outage, wallet errors. Review: waiting, test-call failure, server errors. Overview: no downtime, no buyer code, no sales. Sales: both tables empty. Chat: empty, load error |
| P2 spike: Eternl `signData` verifies with `checkSignature`, fallback library (§12) | Task 6 Step 9 |
| Checkpoints: hour 10 Setup→Review on local DB; hour 18 full flow with real wallet | Task 12 Step 10; Task 16 Step 6 |

**Placeholder scan:** every code step has complete code. The only edits shown as fragments are small and exact: the `globalSetup` line in Task 2, the `escrowSweepNotice` line in Task 13, the `ChatPanel` import and render in Task 15, and the appended functions in Tasks 13 and 14. No "TBD", "similar to" or unwritten helpers. Environment values in Task 16 are named shell variables the operator holds; they are secrets and are not invented here.

**Type consistency check:**
- `Api`, `Operation`, `RuleView`, `Pack`, `RepoResult` and `OnboardStep` are defined once in `lib/types.ts` and used unchanged.
- Money is a `string` in every type and JSON body (`priceMicros`, `escrowPriceMicros`, `packEarningsMicros`), a `bigint` only inside `parseTusdm`/`savePricing`, and `::text` in every SQL read.
- Route handlers all take `(req: Request, ctx: ApiRouteContext)`, and tests pass `ctx(apiId)`.
- `loadOwnedApi` returns `{ session, api, sql }` everywhere.
- `setGatewayForTests` takes a full `Gateway` object in every test.
- `makeTestWallet` exposes `sign` and `signHex`, used by Tasks 5, 6, 11 and 17.
- Column aliases in snake_case map to the camelCase type fields through `postgres.toCamel` (`calls_day` → `callsDay`, `passed_at` → `passedAt`). `dev-coworker` runs with and without the transform, so it aliases explicitly (`op_id as "opId"`).

**Known limits, stated rather than hidden:**
- `getNetworkId() === 0` plus `addr_test1` cannot tell preprod from preview. A preview wallet would sign in but its payments would fail later.
- Login nonces are stateless and valid for 5 minutes, so a captured signature could be replayed in that window. Ownership challenges are single-use DB rows.
- "Calls not passed during downtime" counts only what the gateway logs in `calls`. If P1 does not log 503 refusals as `execution='blocked'`, those refusals are not counted.
- The Sokosumi listing package (spec §5.8) belongs to the coworker, not to web.
- `apis.origin` is taken from the OpenAPI URL's origin at Setup. If P3 overwrites it from `servers[0]` during parsing, the Ownership page uses the updated value automatically, because it reads `api.origin` at render time.
