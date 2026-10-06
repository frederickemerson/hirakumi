# Hirakumi P1 — Gateway & Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Contract v1.1:** read the "Contract v1.1 amendments" section at the end of `2026-10-06-hirakumi-00-contract.md` before starting. It changes: `rules.hash` is not unique (D1); the `start_job` response also includes `amounts` (G7); 401 `token_pending` and `invalid_token` (G4); `X-Credits-Remaining` on 422, 502 and 504 (G5).

**Goal:** Build the repo scaffold, the shared `@hirakumi/core` and `@hirakumi/db` packages, and the `apps/gateway` Express server. The gateway sells call packs over x402 on Cardano preprod, spends credits only when a response keeps the published promise, serves MIP-003 escrow jobs, and keeps `/availability` truthful with an in-process monitor.

**Architecture:** One Express process (`apps/gateway`) on EC2 next to Postgres. Packs go through `@x402/express` `paymentMiddleware`. A `DynamicPrice`/`DynamicPayTo` reads the pack and the seller address from the DB. The handler creates a **pending** credit token. `onAfterSettle` activates it, matched by the hash of the payment payload. Paid calls reserve one credit with a single atomic `UPDATE … RETURNING`, proxy upstream through `safeFetch`, check the compiled rule, then commit (200) or release (422/502/504). A `HealthTracker` in memory, fed by `Monitor`, answers 503 before any payment or credit use. A `JobRunner` polls Masumi for `FundsLocked`, runs the escrow operation, and submits a result only when the rule passes. A `Reconciler` activates pending tokens whose transaction appears on chain and pays the seller.

**Tech Stack:** Node 22+, TypeScript 5.9.3 (ESM, `moduleResolution: Bundler`), pnpm 10 workspaces, tsx 4.23.15, vitest 3.2.7, Express 4.21.2, `@x402/express|core|cardano|fetch` **2.26.0 exactly**, ajv 8.20.0 (draft 2020-12), undici 7.30.0, postgres (postgres.js) 3.4.9, supertest 7.3.1, Postgres 16 (docker, local dev only).

**Spec:** `docs/superpowers/specs/2026-10-06-hirakumi-design.md` (v4)
**Contract:** `docs/superpowers/plans/2026-10-06-hirakumi-00-contract.md` (wins on any disagreement)

---

## Global Constraints (copy exact values from contract)

- Network: **`cardano:preprod` only**. Reject any address that does not start with `addr_test1`.
- **All `@x402/*` packages pinned to exactly `2.26.0`**. Never `^`. `@x402/express@2.26.0` depends on `@x402/core: ~2.26.0` and `@x402/extensions: ~2.26.0`, and `2.27.0`/`2.28.0` exist. The root `package.json` therefore carries `pnpm.overrides` that force every `@x402/*` to `2.26.0`. Task 1 verifies this with `pnpm why`.
- Node **22** or newer, TypeScript, ESM (`"type": "module"`), `tsx` to run, **vitest** for tests. Package manager: **pnpm** workspaces.
- Facilitator (hosted, preprod): `https://x402.preprod.dev.ecosyseng.cf-deployments.org`. Verified on 2026-10-06: `GET /supported` returns `{"kinds":[{"x402Version":2,"scheme":"exact","network":"cardano:preprod","extra":{"assetTransferMethods":["default","masumi","script"],"areFeesSponsored":false,"l1Confirmations":{"minimum":0,"maximum":20}}}],"extensions":[],"signers":{"cardano:*":[]}}`. Local fallback: `npm run facilitator` from the x402-express template, port 4022.
- **Two preprod USDM tokens. Do not mix them up:**
  - **Pack payments (x402):** `USDM_PREPROD_ASSET` exported by `@x402/cardano` = `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d`. Claim at https://tusdm.moneta.global. Blockfrost reports it as unit `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d`, with no dot.
  - **Escrow jobs (Masumi):** policy `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde`, asset name `0014df10745553444d`. Unit = concatenation (`MASUMI_ESCROW_UNIT`). P1 never sends this unit itself; it is P4's `PAYMENT_UNIT`.
- Both tokens have 6 decimals. Store every amount as integer **micros** (`bigint` in SQL, `string` in JSON).
- Upstream limits: **15s timeout, 256 KB request, 1 MB response, no redirects, HTTPS only** (except `http://localhost` when `ALLOW_INSECURE_UPSTREAM=1`; this plan also accepts `http://127.0.0.1` under the same flag, because the test stubs bind there).
- Monitor: production **120s interval, 3 fails → down, 2 passes → healthy**. **Demo mode** (`DEMO_MODE=1`): **10s, 2 fails, 2 passes**.
- Copy rule: user-facing text is plain English. Say "promise" for the acceptance rule, "credits" for pack calls, "Live / Down" for health.
- Gateway writes `credit_tokens`, `calls`, `jobs`, `apis.health*`, `health_events`. It also sets `challenges.consumed_at`/`proof` when the HTTP check passes (single use). It writes no other table outside test seeding.
- x402 client default spend cap is `$1` per payment (`DEFAULT_MAX_AMOUNT_PER_PAYMENT`). A 2 tUSDM pack needs `allowedAssets: [{ network: "cardano:*", asset: USDM_PREPROD_ASSET, maxAmountPerPayment: "2000000" }]` on the buyer (spike and smoke buyer below; tell P5).

## Review Focus

These are the five failure modes the spec implies that are most likely to hurt users. Each has a test in the task that owns it.

1. **A credit is spent on a broken answer, or leaks.** 422, 502, 504 or a thrown error must release the reservation. A release racing with the "exhausted" flip must not lose a credit. Two callers racing for the last credit: exactly one wins. Tests: Task 5 `reserveCredit race` and `release revives exhausted`; Task 8 `422/502/504 leave credits unchanged` and `last credit race over HTTP`.
2. **A credit token works without settled payment.** A token whose settlement failed must stay `pending` and answer 402 `payment_pending`. A replayed payment must not mint a second token or settle twice. A 4xx from the pack handler must cancel settlement. Tests: Task 9 `settle failure leaves token pending`, `replayed payment gets 409 and no second settlement`; Task 14 `reconciler activates only when the chain shows payment to the seller`.
3. **A Down API still takes money.** 503 must come before 402 on the proxy route, before the pack 402 (no x402 offer), and before `start_job` creates a payment request. Tests: Task 8 `503 before 402 when down`; Task 9 `pack route answers 503 and never offers payment when down`; Task 10 `monitor flips to down after 2 demo failures, and availability returns 503`; Task 13 `start_job answers 503 when down`.
4. **Escrow submits a result for a failing response, or runs unpaid.** No `submitResult` on a rule fail, and none before `FundsLocked`. Expire after `payByTime` without calling upstream. Tests: Task 13 `fail submits nothing`, `waiting for payment never calls upstream`, `expired job`.
5. **The seller origin is used for SSRF.** Private, loopback, link-local and metadata IPs (literal or via DNS), redirects, `http:` and oversize bodies must all be refused. Tests: Task 4 `safeFetch blocks …` table.

---

## File Structure

```
token2049/
  package.json                       # T1 workspace root: scripts, pnpm.overrides (@x402/* = 2.26.0)
  pnpm-workspace.yaml                # T1 packages: apps/*, packages/*, sellers/*, agents/*, cre/*
  tsconfig.base.json                 # T1 shared compiler options (ESNext + Bundler resolution, strict)
  .gitignore                         # T1
  .env.example                       # T1 verbatim from contract
  docker-compose.dev.yml             # T1 local-dev Postgres only (P4 owns docker-compose.yml)
  db/migrations/0001_init.sql        # T1 verbatim from contract
  packages/db/
    package.json, tsconfig.json      # T1
    src/client.ts                    # T1 createDb(url, {searchPath,max}) → postgres.js Sql
    src/migrate.ts                   # T1 migrate(sql): ordered, advisory-locked, recorded in schema_migrations
    src/migrate-cli.ts               # T1 `pnpm db:migrate`
    src/testing.ts                   # T1 createTestDb(): throwaway schema per test + migrations
    src/gateway.ts                   # T5 typed query helpers the gateway uses
    src/index.ts                     # T1/T5 public exports
    test/migrate.test.ts             # T1
    test/gateway.test.ts             # T5
  packages/core/
    package.json, tsconfig.json      # T2
    src/ids.ts                       # T2 newId, newBearerToken, sha256Hex
    src/jcs.ts                       # T2 RFC 8785 canonical JSON
    src/hashing.ts                   # T2 MIP-004 inputHash/outputHash
    src/challenge.ts                 # T2 buildWalletChallenge, httpChallengePath
    src/rules.ts                     # T3 RuleDefinition, compileRule (+maxAgeSeconds), ruleHash, inferRule, formatSchemaErrors
    src/fetch.ts                     # T4 safeFetch, UpstreamBlocked/Timeout/TooLarge errors, isBlockedAddress
    src/index.ts                     # T2–T4 public exports
    test/ids.test.ts, test/hashing.test.ts, test/challenge.test.ts   # T2
    test/rules.test.ts               # T3
    test/fetch.test.ts               # T4
  apps/gateway/
    package.json, tsconfig.json, vitest.config.ts   # T6
    src/config.ts                    # T6 GatewayConfig, loadConfig(env)
    src/health.ts                    # T6 HealthTracker (pure state machine)
    src/masumi-port.ts               # T7 MasumiPort (contract functions bound to config)
    src/registry.ts                  # T7 ApiRegistry cache, LoadedApi/LoadedOp, input validators, escrowOperation, primaryRule
    src/upstream.ts                  # T7 buildUpstreamRequest, normalizeMip003Input, runOperation
    src/deps.ts                      # T7 AppDeps type
    src/http.ts                      # T8 parseBearer, response bodies, errorHandler
    src/credits.ts                   # T8 GET|POST /a/:apiId/x/:opId
    src/app.ts                       # T8 createApp (T9–T13 add routers)
    src/packs.ts                     # T9 POST /a/:apiId/packs/:packId (x402) + settle hooks
    src/monitor.ts                   # T10 Monitor (probes, transitions, health_events)
    src/mip003.ts                    # T10 availability; T13 start_job/status/input_schema
    src/internal.ts                  # T11 /internal/* routes
    src/main.ts                      # T12 process entry; T15 adds Masumi, JobRunner, Reconciler
    src/jobs.ts                      # T13 JobRunner
    src/reconcile.ts                 # T14 Reconciler + blockfrostLookup
    src/masumi-live.ts               # T15 binds @hirakumi/masumi to MasumiPort
    scripts/stub-seller.ts           # T12 local break-switch seller for the checkpoint
    scripts/seed-demo.ts             # T12 manual onboarding in SQL (samples → inferRule → rows)
    scripts/smoke-buyer.ts           # T12 preprod buyer: 402 → pay pack → call
    test/helpers.ts                  # T7 stub upstream, seeding, fakes; T8 adds makeHarness
    test/config.test.ts, test/health.test.ts           # T6
    test/registry.test.ts, test/upstream.test.ts       # T7
    test/credits.test.ts             # T8
    test/packs.test.ts               # T9
    test/monitor.test.ts             # T10
    test/internal.test.ts            # T11
    test/mip003.test.ts              # T13
    test/reconcile.test.ts           # T14
```

**Contract decisions this plan makes** (also listed in the Self-Review):
- `/a/:apiId/x/:opId` and `calls.op_id` use `operations.op_id` (the OpenAPI operationId), not `operations.id`.
- `apis.escrow_op_id` is matched against `operations.id` first, then `operations.op_id` (`escrowOperation()`).
- The pack 402 `extra.ruleHash` is the escrow operation's rule. If none is set, it falls back to the first enabled operation with a rule (`primaryRule()`).
- `operations.input_schema` must be a flat JSON Schema object: path parameters, query parameters and JSON body fields all appear as `properties`. Path parameters are the `{name}` tokens in `operations.path`.
- `health_events.reasons` is an array of `{ op, reason, since }` objects. `since` is the ISO time of the first failure in the run.
- A replayed pack payment answers **409** `payment_already_used`. The raw token is shown once and stored only as a hash, so it can't be returned again. Answering 409 also cancels settlement.
- Escrow `submitResult` gets the MIP-004 **output hash** (64 hex). This matches `x402-cardano-demo/masumi/src/masumi.ts` `resultHash`. The skill reference shows `inputHash + outputHash`; P4's adapter has the final say.

---

### Task 0: Feasibility spike on preprod (hours 0–2, no repo code)

**Files:** none in the repo. Work in `/private/tmp/claude-501/hk/x402-express` (the installed template). Create `src/spike-seller.ts` and `src/spike-buyer.ts` there.

**Interfaces:** Consumes `paymentMiddleware(routes, server)` from `@x402/express`; `x402ResourceServer#onAfterVerify/onAfterSettle/onSettleFailure/onVerifiedPaymentCanceled`; `HTTPFacilitatorClient({url})` from `@x402/core/server`; `ExactCardanoScheme` from `@x402/cardano/exact/server` (seller) and `@x402/cardano/exact/client` (buyer); `USDM_PREPROD_ASSET`, `decodeCardanoTransaction`, `toClientCardanoSigner` from `@x402/cardano`; `x402Client`, `wrapFetchWithPayment`, `x402HTTPClient` from `@x402/fetch`. All were checked in `node_modules/@x402/*/dist/esm/*.d.mts`. Produces: a results table posted in team chat (format at the end of this task).

What the 2.26.0 sources already show (re-check during the spike, don't assume):
- `@x402/express` (dist/esm/index.mjs) runs the handler with the response buffered. If `res.statusCode >= 400` it calls `cancellationDispatcher.cancel({reason:"handler_failed"})` and **never settles**. Otherwise it awaits `processSettlement(...)` **before** flushing the response, and passes `transportContext = { request, responseBody, responseHeaders }`.
- `SettleContext` = `{ paymentPayload, requirements, declaredExtensions, phase, transportContext? }`; `SettleResultContext` adds `result: SettleResponse` (`transaction`, `payer`, `network`, `success`); `SettleFailureContext` adds `error: Error`. Hook errors are caught and logged by core (`warnResourceServerHookFailure`), never thrown to the client.
- `DynamicPrice = (ctx: HTTPRequestContext) => Price | Promise<Price>`; `AssetAmount = { asset, amount, extra? }`. Core builds `requirements.extra = { ...parsedPrice.extra, ...option.extra }`, so dynamic per-pack `extra` must go in the **price's** `extra`.
- Route patterns accept `:param` (`parseRoutePattern` converts `:name` to `[^/]+`).

- [ ] **Step 1: Prepare two wallets and funds**

```bash
cd /private/tmp/claude-501/hk/x402-express
cp -n .env.example .env
npx tsx src/wallet.ts   # BUYER: copy MNEMONIC=... into .env, note the address as BUYER_ADDR
npx tsx src/wallet.ts   # SELLER: put its address into .env as SELLER_ADDRESS=addr_test1...
# Fund BUYER_ADDR: tADA https://docs.cardano.org/cardano-testnets/tools/faucet ; tUSDM https://tusdm.moneta.global/#manual
# Put BLOCKFROST_PROJECT_ID=preprod... into .env
export BF=https://cardano-preprod.blockfrost.io/api/v0
set -a; . ./.env; set +a
curl -s -H "project_id: $BLOCKFROST_PROJECT_ID" $BF/addresses/<BUYER_ADDR> | jq '.amount'
```
Expected: `lovelace` ≥ 10000000 and an entry with unit `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d`.

- [ ] **Step 2: Write the spike seller**

`/private/tmp/claude-501/hk/x402-express/src/spike-seller.ts`:
```ts
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type HTTPTransportContext } from "@x402/core/server";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { USDM_PREPROD_ASSET, decodeCardanoTransaction } from "@x402/cardano";

config();
const payTo = process.env.SELLER_ADDRESS ?? "";
const facilitatorUrl = process.env.FACILITATOR_URL ?? "";
if (!payTo.startsWith("addr_test1") || !facilitatorUrl) throw new Error("Set SELLER_ADDRESS and FACILITATOR_URL");
const L1 = Number(process.env.L1_CONFIRMATIONS ?? "0");
const verifiedAt = new Map<string, number>();

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
  .register("cardano:preprod", new ExactCardanoScheme());
server.onAfterVerify(async (ctx) => {
  if (!ctx.result.isValid) { console.log(`[verify] invalid ${ctx.result.invalidReason}`); return; }
  const tx = decodeCardanoTransaction(String(ctx.paymentPayload.payload.transaction));
  verifiedAt.set(tx.txHash, Date.now());
  console.log(`[verify] ok tx=${tx.txHash} outputs=${tx.outputs.length}`);
  for (const o of tx.outputs) {
    const assets = Object.fromEntries(Object.entries(o.assets).map(([k, v]) => [k, String(v)]));
    console.log(`  output ${o.address} coin=${String(o.coin)} assets=${JSON.stringify(assets)}`);
  }
});
server.onAfterSettle(async (ctx) => {
  const tc = ctx.transportContext as HTTPTransportContext | undefined;
  const t0 = verifiedAt.get(ctx.result.transaction);
  console.log(`[afterSettle] phase=${ctx.phase} success=${ctx.result.success} tx=${ctx.result.transaction} payer=${ctx.result.payer} ` +
    `path=${tc?.request.path} bodyBytes=${tc?.responseBody?.length} verify→settle=${t0 ? Date.now() - t0 : "?"}ms`);
});
server.onSettleFailure(async (ctx) => { console.log(`[settleFailure] phase=${ctx.phase} error=${ctx.error.message}`); });
server.onVerifiedPaymentCanceled(async (ctx) => { console.log(`[canceled] reason=${ctx.reason} status=${ctx.responseStatus}`); });

const accepts = {
  scheme: "exact",
  network: "cardano:preprod" as const,
  payTo,
  price: { amount: "100000", asset: USDM_PREPROD_ASSET,
           extra: { apiId: "api_spike", packId: "pk_spike", calls: 100, ruleHash: "sha256:spike" } },
  maxTimeoutSeconds: 600,
  extra: { confirmationPolicy: { l1Confirmations: L1 } },
};
const app = express();
app.use(paymentMiddleware({
  "POST /pack": { accepts, description: "spike pack", mimeType: "application/json" },
  "POST /fail": { accepts, description: "spike 422", mimeType: "application/json" },
}, server));
app.post("/pack", (_req, res) => { res.json({ token: "hk_spike", credits: 100 }); });
app.post("/fail", (_req, res) => { res.status(422).json({ error: "promise_not_met" }); });
app.listen(4021, () => console.log(`spike seller on :4021 l1Confirmations=${L1} facilitator=${facilitatorUrl}`));
```

- [ ] **Step 3: Write the spike buyer**

`/private/tmp/claude-501/hk/x402-express/src/spike-buyer.ts`:
```ts
import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { toClientCardanoSigner, USDM_PREPROD_ASSET } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";

config();
const path = process.argv[2] ?? "/pack";
const client = new x402Client().setSpendControls({
  allowedAssets: [{ network: "cardano:*", asset: USDM_PREPROD_ASSET, maxAmountPerPayment: "2000000" }],
});
const signer = toClientCardanoSigner({
  mnemonic: process.env.MNEMONIC ?? "",
  network: "cardano:preprod",
  provider: { blockfrost: { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId: process.env.BLOCKFROST_PROJECT_ID ?? "" } },
});
client.register("cardano:*", new ExactCardanoScheme(signer));
console.log(`buyer ${signer.getAddress()} → POST ${path}`);
const started = Date.now();
const res = await wrapFetchWithPayment(fetch, client)(`http://localhost:4021${path}`, { method: "POST" });
console.log(`HTTP ${res.status} after ${((Date.now() - started) / 1000).toFixed(1)}s`, await res.text());
try {
  const receipt = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
  console.log("receipt", JSON.stringify(receipt));
} catch (e) { console.log("no PAYMENT-RESPONSE receipt:", (e as Error).message); }
```

- [ ] **Step 4: Settle tUSDM with `l1Confirmations: 0` and check that the hooks fire**

```bash
cd /private/tmp/claude-501/hk/x402-express
L1_CONFIRMATIONS=0 npx tsx src/spike-seller.ts      # terminal A
npx tsx src/spike-buyer.ts /pack                    # terminal B
```
Expected: B prints `HTTP 200 after N s {"token":"hk_spike","credits":100}` and a receipt with `transaction`. A prints `[verify] ok …`, then `[afterSettle] phase=after-handler success=true tx=… path=/pack bodyBytes=…`. Record N (wall-clock) and `verify→settle` ms. Check on chain:
```bash
curl -s -H "project_id: $BLOCKFROST_PROJECT_ID" $BF/txs/<tx>/utxos | jq '.outputs[] | {address, amount}'
```
Expected: one output to `SELLER_ADDRESS` with unit `e675…745553444d` quantity `100000`.

- [ ] **Step 5: Measure `l1Confirmations: 1` for comparison**

Restart A with `L1_CONFIRMATIONS=1 npx tsx src/spike-seller.ts`, re-run B. Record N. Expected: N(1) > N(0). If the facilitator rejects 0 (`confirmation range does not include 0` at startup), set `l1Confirmations` in gateway config to the advertised minimum and record it.

- [ ] **Step 6: Confirm that a 4xx handler response cancels settlement (buyer UTxOs unchanged)**

```bash
curl -s -H "project_id: $BLOCKFROST_PROJECT_ID" $BF/addresses/<BUYER_ADDR>/utxos | jq -r '.[] | "\(.tx_hash)#\(.output_index)"' | sort > /tmp/utxo-before.txt
npx tsx src/spike-buyer.ts /fail
sleep 60
curl -s -H "project_id: $BLOCKFROST_PROJECT_ID" $BF/addresses/<BUYER_ADDR>/utxos | jq -r '.[] | "\(.tx_hash)#\(.output_index)"' | sort > /tmp/utxo-after.txt
diff /tmp/utxo-before.txt /tmp/utxo-after.txt && echo "UNSPENT: settlement cancelled"
```
Expected: B prints `HTTP 422 … promise_not_met` and "no PAYMENT-RESPONSE receipt". A prints `[canceled] reason=handler_failed status=422` and **no** `[afterSettle]`. The diff is empty.

- [ ] **Step 7: Check that `onSettleFailure` fires (local facilitator, broken settle)**

```bash
npm run facilitator                                  # terminal C (port 4022)
FACILITATOR_URL=http://127.0.0.1:4022 L1_CONFIRMATIONS=0 npx tsx src/spike-seller.ts   # restart A
# Spend the buyer's UTxOs between verify and settle is impractical; instead stop C right after A logs "[verify] ok":
npx tsx src/spike-buyer.ts /pack    # B; when A prints "[verify] ok", Ctrl-C terminal C immediately
```
Expected: A prints `[settleFailure] phase=after-handler error=…` (fetch failure). B gets a non-200 (502 from `sendFacilitatorError`, or 402). If you can't hit the window by hand, record "settle-failure hook verified by unit test only (Task 9)". Task 9 drives the same code path with a fake facilitator.

- [ ] **Step 8: Can one payment carry two outputs (seller plus fee)?**

```bash
cd /private/tmp/claude-501/hk/x402-express/node_modules/@x402/cardano/dist/esm
sed -n 840,910p exact/facilitator/index.mjs           # how verify finds the payTo output
grep -n "payTo" exact/client/index.mjs | head -20      # how the client builds outputs
```
In Step 4's `[verify]` log, count `output` lines: payTo plus change. Record:
(a) Does the facilitator require exactly one non-change output? It searches for an output to `requirements.payTo`.
(b) Does the stock client build any output other than payTo and change?
Decision rule: if (b) is "no", a 3% fee output needs a custom client that standard x402 buyers don't run, so **bill the fee monthly** (spec §9 fallback). Don't build a fee output.

- [ ] **Step 9: Post results (copy this table into team chat)**

```
P1 spike (x402 2.26.0, hosted facilitator)
| check                                   | result |
| tUSDM settle, l1Confirmations=0         | OK/FAIL, tx=…, wall=…s, verify→settle=…ms |
| l1Confirmations=1                       | wall=…s |
| onAfterSettle fires, phase              | yes/no, phase=after-handler |
| onSettleFailure fires                   | yes/no/unit-test-only |
| 422 handler cancels settlement          | yes/no (utxo diff empty?) |
| outputs per payment                     | n (payTo + change) |
| two-output fee                          | not possible with stock client → monthly billing / possible |
| facilitator l1Confirmations range       | 0..20 |
```
Fallbacks per the spec: if the hosted facilitator fails, use `FACILITATOR_URL=http://127.0.0.1:4022` (local). If tUSDM fails, run the spike with `{ amount: "2000000", asset: "lovelace" }` and tell the team.

### Task 1: Repo scaffold, migration 0001 and the migration runner

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `docker-compose.dev.yml`, `db/migrations/0001_init.sql`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/src/client.ts`, `packages/db/src/migrate.ts`, `packages/db/src/migrate-cli.ts`, `packages/db/src/testing.ts`, `packages/db/src/index.ts`
- Test: `packages/db/test/migrate.test.ts`

**Interfaces:**
- Consumes: the contract's SQL and `.env.example`.
- Produces:
  - `export type Sql = postgres.Sql`
  - `export function createDb(url: string, opts?: { searchPath?: string; max?: number }): Sql`
  - `export const MIGRATIONS_DIR: string`
  - `export function migrate(sql: Sql, dir?: string): Promise<string[]>` (names applied this run)
  - `export type TestDb = { sql: Sql; schema: string; drop(): Promise<void> }`
  - `export function createTestDb(): Promise<TestDb>` (from `@hirakumi/db/testing`)

- [ ] **Step 1: Initialise git and the workspace root**

```bash
cd /Users/frederick/Documents/Projects/token2049
test -d .git || git init -b main
node -v   # expect v22 or newer
pnpm -v   # expect 10.x
mkdir -p db/migrations packages/db/src packages/db/test
```

`package.json`:
```json
{
  "name": "hirakumi",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.28.1",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "pnpm -r --workspace-concurrency=1 test",
    "typecheck": "pnpm -r typecheck",
    "db:up": "docker compose -f docker-compose.dev.yml up -d postgres",
    "db:migrate": "pnpm --filter @hirakumi/db migrate"
  },
  "pnpm": {
    "overrides": {
      "@x402/core": "2.26.0",
      "@x402/extensions": "2.26.0",
      "@x402/cardano": "2.26.0",
      "@x402/express": "2.26.0",
      "@x402/fetch": "2.26.0"
    },
    "onlyBuiltDependencies": ["esbuild"]
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "tsx": "4.23.15",
    "typescript": "5.9.3",
    "vitest": "3.2.7"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages: ["apps/*", "packages/*", "sellers/*", "agents/*", "cre/*"]
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`.gitignore`:
```
node_modules/
.env
dist/
.next/
coverage/
*.log
```

`.env.example` (verbatim from contract):
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

`docker-compose.dev.yml` (local dev only; P4 owns `docker-compose.yml`):
```yaml
services:
  postgres:
    image: postgres:16-alpine
    command: ["postgres", "-c", "max_connections=300"]
    environment:
      POSTGRES_USER: hirakumi
      POSTGRES_PASSWORD: hirakumi
      POSTGRES_DB: hirakumi
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hirakumi -d hirakumi"]
      interval: 2s
      timeout: 3s
      retries: 30
volumes:
  pgdata: {}
```

- [ ] **Step 2: Add the migration, verbatim from the contract**

`db/migrations/0001_init.sql`:
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

Check it matches the contract byte for byte:
```bash
diff <(awk '/^```sql/{f=1;next} /^```/{if(f){exit}} f' docs/superpowers/plans/2026-10-06-hirakumi-00-contract.md) db/migrations/0001_init.sql && echo IDENTICAL
```
Expected: `IDENTICAL`.

- [ ] **Step 3: Create the db package skeleton and install**

`packages/db/package.json`:
```json
{
  "name": "@hirakumi/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p .",
    "migrate": "tsx src/migrate-cli.ts"
  },
  "dependencies": { "postgres": "3.4.9" },
  "devDependencies": { "@types/node": "22.20.5", "tsx": "4.23.15", "typescript": "5.9.3", "vitest": "3.2.7" }
}
```

`packages/db/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```bash
pnpm install
pnpm db:up
docker compose -f docker-compose.dev.yml ps   # expect postgres "healthy"
```

- [ ] **Step 4: Write the failing test**

`packages/db/test/migrate.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing";
import { migrate } from "../src/migrate";

let db: TestDb | undefined;
afterEach(async () => { await db?.drop(); db = undefined; });

describe("migrate", () => {
  it("creates every contract table inside the throwaway schema", async () => {
    db = await createTestDb();
    const rows = await db.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = ${db.schema} order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      "apis", "calls", "challenges", "credit_tokens", "health_events", "jobs", "onboard_steps",
      "operations", "packs", "rules", "schema_migrations", "sellers", "test_inputs",
    ]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    db = await createTestDb();
    expect(await migrate(db.sql)).toEqual([]);
  });

  it("rejects non-preprod seller addresses", async () => {
    db = await createTestDb();
    await expect(db.sql`insert into sellers (id, cardano_addr) values ('sel_x', 'addr1qxyz')`)
      .rejects.toThrow(/check constraint/);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm --filter @hirakumi/db exec vitest run test/migrate.test.ts`
Expected: FAIL, `Failed to resolve import "../src/testing"`.

- [ ] **Step 6: Implement the client, the runner and the test helper**

`packages/db/src/client.ts`:
```ts
import postgres from "postgres";

export type Sql = postgres.Sql;

/** One pooled postgres.js client. `searchPath` pins every connection to one schema (tests use this). */
export function createDb(url: string, opts: { searchPath?: string; max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => undefined,
    ...(opts.searchPath
      ? { connection: { search_path: opts.searchPath } as unknown as postgres.Options<{}>["connection"] }
      : {}),
  });
}
```

`packages/db/src/migrate.ts`:
```ts
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./client";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const LOCK_KEY = 727274; // any constant; serialises concurrent migrators (gateway + coworker boot together)

/** Applies every *.sql in `dir` not yet in schema_migrations, in file-name order, in one transaction. */
export async function migrate(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx.unsafe(`select pg_advisory_xact_lock(${LOCK_KEY})`);
    await tx.unsafe(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (await tx.unsafe<{ name: string }[]>("select name from schema_migrations")).map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(await readFile(join(dir, file), "utf8"));
      await tx.unsafe("insert into schema_migrations (name) values ($1)", [file]);
      applied.push(file);
    }
  });
  return applied;
}
```

`packages/db/src/migrate-cli.ts`:
```ts
import { createDb } from "./client";
import { migrate } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (see .env.example)");
  process.exit(1);
}
const sql = createDb(url, { max: 1 });
try {
  const applied = await migrate(sql);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
} finally {
  await sql.end();
}
```

`packages/db/src/testing.ts`:
```ts
import { randomBytes } from "node:crypto";
import { createDb, type Sql } from "./client";
import { migrate } from "./migrate";

export type TestDb = { sql: Sql; schema: string; drop(): Promise<void> };

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";

/** A fresh schema with all migrations applied. Every test gets its own; drop() removes it. */
export async function createTestDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = createDb(TEST_URL, { max: 1 });
  await admin.unsafe(`create schema ${schema}`);
  await admin.end();
  const sql = createDb(TEST_URL, { searchPath: schema, max: 4 });
  await migrate(sql);
  return {
    sql,
    schema,
    async drop() {
      await sql.end();
      const a = createDb(TEST_URL, { max: 1 });
      await a.unsafe(`drop schema if exists ${schema} cascade`);
      await a.end();
    },
  };
}
```

`packages/db/src/index.ts`:
```ts
export * from "./client";
export * from "./migrate";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/db exec vitest run test/migrate.test.ts`
Expected: PASS (3 tests). If the first test fails because the tables landed in `public`, postgres.js isn't sending `search_path` as a startup parameter. Verify with:
`node --input-type=module -e "import p from 'postgres'; const s=p('postgres://hirakumi:hirakumi@localhost:5432/hirakumi',{connection:{search_path:'pg_catalog'}}); console.log(await s\`show search_path\`); await s.end()"` (run from `packages/db`). Expected: `[ { search_path: 'pg_catalog' } ]`. If it differs, use the standard libpq startup option instead. In `createDb`, replace `{ search_path: opts.searchPath }` with `{ options: \`-c search_path=${opts.searchPath}\` }` and re-run the test.

- [ ] **Step 8: Check the migration CLI and typecheck**

```bash
pnpm db:migrate     # expect "Applied: 0001_init.sql" the first time, then "Database is up to date."
pnpm --filter @hirakumi/db typecheck   # expect no output, exit 0
```

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .gitignore .env.example docker-compose.dev.yml db/migrations/0001_init.sql packages/db
git commit -m "chore: scaffold pnpm workspace, dev postgres, migration 0001 and runner" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Core ids, JCS, MIP-004 hashing and challenge format

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/ids.ts`, `packages/core/src/jcs.ts`, `packages/core/src/hashing.ts`, `packages/core/src/challenge.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/ids.test.ts`, `packages/core/test/hashing.test.ts`, `packages/core/test/challenge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (contract signatures, plus `jcs`):
  - `export type IdPrefix = "sel" | "api" | "op" | "pk" | "ct" | "call" | "job" | "rule" | "ch" | "ti"`
  - `export function newId(prefix: IdPrefix): string`
  - `export function newBearerToken(): string`
  - `export function sha256Hex(s: string): string`
  - `export function jcs(value: unknown): string`
  - `export function inputHash(identifier: string, input: unknown): string`
  - `export function outputHash(identifier: string, raw: string): string`
  - `export type WalletChallengeFields = { domain: string; sellerId: string; apiId: string; origin: string; payTo: string; network: "cardano:preprod"; nonce: string; expires: string }`
  - `export function buildWalletChallenge(f: WalletChallengeFields): string`
  - `export function httpChallengePath(apiId: string): string`

- [ ] **Step 1: Create the package skeleton**

`packages/core/package.json`:
```json
{
  "name": "@hirakumi/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit -p ." },
  "dependencies": { "ajv": "8.20.0", "undici": "7.30.0" },
  "devDependencies": {
    "@types/node": "22.20.5",
    "@x402/cardano": "2.26.0",
    "typescript": "5.9.3",
    "vitest": "3.2.7"
  }
}
```
`@x402/cardano` is a **dev** dependency only. Tests use its `jcs` as the reference implementation, so `@hirakumi/core` stays light enough for the Next.js app (P2).

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```bash
mkdir -p packages/core/src packages/core/test && pnpm install
pnpm why @x402/core -r | grep -E "@x402/core [0-9]" | sort -u   # expect only "@x402/core 2.26.0"
```

- [ ] **Step 2: Write the failing tests**

`packages/core/test/ids.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { newBearerToken, newId, sha256Hex } from "../src/ids";

describe("ids", () => {
  it("newId is prefix + '_' + 10 lowercase base32 chars and unique", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId("api")));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^api_[a-z2-7]{10}$/);
    expect(newId("ct")).toMatch(/^ct_[a-z2-7]{10}$/);
  });
  it("newBearerToken is hk_ + 43 base64url chars (32 bytes)", () => {
    const t = newBearerToken();
    expect(t).toMatch(/^hk_[A-Za-z0-9_-]{43}$/);
    expect(newBearerToken()).not.toBe(t);
  });
  it("sha256Hex hashes UTF-8", () => {
    expect(sha256Hex("héllo")).toBe(createHash("sha256").update("héllo", "utf8").digest("hex"));
  });
});
```

`packages/core/test/hashing.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { jcs as referenceJcs } from "@x402/cardano";
import { jcs } from "../src/jcs";
import { inputHash, outputHash } from "../src/hashing";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("jcs (RFC 8785)", () => {
  it("sorts keys, drops undefined, keeps arrays in order, normalises -0", () => {
    expect(jcs({ b: 2, a: [1, "x", null, true], c: { z: 1.5e-7, y: -0, u: undefined } }))
      .toBe('{"a":[1,"x",null,true],"b":2,"c":{"y":0,"z":1.5e-7}}');
  });
  it("matches @x402/cardano's jcs on a mixed corpus (the Masumi reference)", () => {
    const corpus: unknown[] = [
      { symbol: "ADA", n: 10, nested: { "é": 1, z: 2, "€": 3, a: [] } },
      [{ key: "symbol", value: "ADA" }, { key: "limit", value: 5 }],
      { big: 1e21, small: 1e-7, int: 42, neg: -3.25, s: "quote\" back\\ ctrl\u0001 emoji😀" },
      "plain", 0, true, null,
    ];
    for (const v of corpus) expect(jcs(v)).toBe(referenceJcs(v));
  });
  it("rejects non-finite numbers", () => {
    expect(() => jcs({ x: Number.NaN })).toThrow(/non-finite/);
  });
});

describe("MIP-004 hashing", () => {
  it("inputHash = sha256(identifier + ';' + jcs(input))", () => {
    expect(inputHash("abc123", { symbol: "ADA", a: 1 })).toBe(sha('abc123;{"a":1,"symbol":"ADA"}'));
  });
  it("outputHash = sha256(identifier + ';' + raw)", () => {
    expect(outputHash("abc123", '{"price":1}')).toBe(sha('abc123;{"price":1}'));
  });
});
```

`packages/core/test/challenge.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildWalletChallenge, httpChallengePath, type WalletChallengeFields } from "../src/challenge";

const fields: WalletChallengeFields = {
  domain: "hirakumi.vercel.app", sellerId: "sel_abcdefghij", apiId: "api_abcdefghij",
  origin: "https://price.example.dev", payTo: "addr_test1qpexample", network: "cardano:preprod",
  nonce: "n0nce", expires: "2026-10-06T12:30:00.000Z",
};

describe("challenge", () => {
  it("builds a stable line-based message", () => {
    expect(buildWalletChallenge(fields)).toBe([
      "Hirakumi ownership proof",
      "domain: hirakumi.vercel.app",
      "seller: sel_abcdefghij",
      "api: api_abcdefghij",
      "origin: https://price.example.dev",
      "payTo: addr_test1qpexample",
      "network: cardano:preprod",
      "nonce: n0nce",
      "expires: 2026-10-06T12:30:00.000Z",
    ].join("\n"));
  });
  it("refuses line breaks (no field can forge another line)", () => {
    expect(() => buildWalletChallenge({ ...fields, origin: "https://a\npayTo: addr_test1evil" })).toThrow(/line break/);
  });
  it("refuses mainnet addresses", () => {
    expect(() => buildWalletChallenge({ ...fields, payTo: "addr1qxyz" })).toThrow(/addr_test1/);
  });
  it("httpChallengePath", () => {
    expect(httpChallengePath("api_abcdefghij")).toBe("/.well-known/hirakumi/api_abcdefghij.txt");
    expect(() => httpChallengePath("../etc/passwd")).toThrow(/api id/);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @hirakumi/core exec vitest run`
Expected: FAIL, `Failed to resolve import "../src/ids"` (and likewise for the other files).

- [ ] **Step 4: Implement**

`packages/core/src/ids.ts`:
```ts
import { createHash, randomBytes } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export type IdPrefix = "sel" | "api" | "op" | "pk" | "ct" | "call" | "job" | "rule" | "ch" | "ti";

export function newId(prefix: IdPrefix): string {
  let out = "";
  for (const b of randomBytes(10)) out += BASE32[b & 31];
  return `${prefix}_${out}`;
}

export function newBearerToken(): string {
  return `hk_${randomBytes(32).toString("base64url")}`;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
```

`packages/core/src/jcs.ts`:
```ts
/**
 * RFC 8785 JSON Canonicalization Scheme. ES number and string serialisation (JSON.stringify)
 * is exactly what RFC 8785 specifies; keys are sorted by UTF-16 code units (default sort).
 */
export function jcs(value: unknown): string {
  let v = value;
  if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") {
    v = (v as { toJSON(): unknown }).toJSON();
  }
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new TypeError("JCS: non-finite number");
      return JSON.stringify(v);
    case "string":
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) {
        return `[${v.map((x) => (x === undefined || typeof x === "function" || typeof x === "symbol" ? "null" : jcs(x))).join(",")}]`;
      }
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined && typeof o[k] !== "function" && typeof o[k] !== "symbol")
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`JCS: cannot serialise ${typeof v}`);
  }
}
```

`packages/core/src/hashing.ts`:
```ts
import { jcs } from "./jcs";
import { sha256Hex } from "./ids";

/** MIP-004 input hash: sha256(identifier + ";" + JCS(input)), lowercase hex. */
export function inputHash(identifier: string, input: unknown): string {
  return sha256Hex(`${identifier};${jcs(input)}`);
}

/** MIP-004 output hash: sha256(identifier + ";" + raw output string), lowercase hex. */
export function outputHash(identifier: string, raw: string): string {
  return sha256Hex(`${identifier};${raw}`);
}
```

`packages/core/src/challenge.ts`:
```ts
export type WalletChallengeFields = {
  domain: string; sellerId: string; apiId: string; origin: string;
  payTo: string; network: "cardano:preprod"; nonce: string; expires: string;
};

/** The exact text the seller signs with CIP-30 signData. Line-based, fixed order. */
export function buildWalletChallenge(f: WalletChallengeFields): string {
  for (const [k, v] of Object.entries(f)) {
    if (/[\r\n]/.test(v)) throw new Error(`challenge field ${k} must not contain a line break`);
  }
  if (!f.payTo.startsWith("addr_test1")) throw new Error("payTo must be a preprod address (addr_test1…)");
  if (f.network !== "cardano:preprod") throw new Error("network must be cardano:preprod");
  return [
    "Hirakumi ownership proof",
    `domain: ${f.domain}`,
    `seller: ${f.sellerId}`,
    `api: ${f.apiId}`,
    `origin: ${f.origin}`,
    `payTo: ${f.payTo}`,
    `network: ${f.network}`,
    `nonce: ${f.nonce}`,
    `expires: ${f.expires}`,
  ].join("\n");
}

export function httpChallengePath(apiId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(apiId)) throw new Error(`invalid api id: ${apiId}`);
  return `/.well-known/hirakumi/${apiId}.txt`;
}
```

`packages/core/src/index.ts`:
```ts
export * from "./ids";
export * from "./jcs";
export * from "./hashing";
export * from "./challenge";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/core exec vitest run`
Expected: PASS (ids 3, hashing 5, challenge 4).

- [ ] **Step 6: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): ids, RFC 8785 JCS, MIP-004 hashes and challenge format" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Rule engine: compileRule with `maxAgeSeconds`, ruleHash, inferRule

**Files:**
- Create: `packages/core/src/rules.ts`, `packages/core/src/fetch.ts` (type only for now; Task 4 adds the rest)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/rules.test.ts`

**Interfaces:**
- Consumes: `jcs`, `sha256Hex` (Task 2).
- Produces (contract, plus helpers):
  - `export type UpstreamResult = { status: number; contentType: string | null; body: string; latencyMs: number }`
  - `export type RuleDefinition = { version: 1; status: { min: number; max: number }; contentType: "application/json"; schema: Record<string, unknown> }`
  - `export type Verdict = { pass: boolean; reasons: string[] }`
  - `export type CompiledRule = { hash: string; check(res: UpstreamResult): Verdict }`
  - `export function compileRule(def: RuleDefinition): CompiledRule` (cached by hash)
  - `export function ruleHash(def: RuleDefinition): string`
  - `export function inferRule(samples: unknown[], errorSample?: unknown): RuleDefinition`
  - `export function inferSchema(values: unknown[]): Record<string, unknown>`
  - `export function ageSeconds(value: string | number, nowMs: number): number | null`
  - `export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[]` (the gateway reuses it for input errors)
  - `export const DEFAULT_MAX_AGE_SECONDS = 300`

How `inferRule` decides on `maxAgeSeconds`: it uses the **values**, not field names. A string field gets `maxAgeSeconds: 300` only when every sample value is an ISO 8601 date-time **and** every one was fresh (within 300s) when sampled. That means the field behaves like a freshness stamp. A `createdAt: 2019-…` field is typed as a plain string.

- [ ] **Step 1: Verify the ajv import shape**

```bash
cd packages/core && node --input-type=module -e "import A from 'ajv/dist/2020.js'; const a=new A(); console.log(typeof A, typeof a.compile, typeof a.addKeyword)"; cd ../..
```
Expected: `function function function`. If the first word is `object`, use `A.default` in `rules.ts` (`const Ajv = (Ajv2020 as unknown as { default: typeof Ajv2020 }).default ?? Ajv2020`).

- [ ] **Step 2: Write the failing test**

`packages/core/test/rules.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileRule, inferRule, ruleHash, type RuleDefinition } from "../src/rules";
import type { UpstreamResult } from "../src/fetch";

const NOW = new Date("2026-10-06T12:00:00.000Z");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

const priceRule: RuleDefinition = {
  version: 1,
  status: { min: 200, max: 299 },
  contentType: "application/json",
  schema: {
    type: "object",
    required: ["price", "symbol", "updatedAt"],
    properties: {
      price: { type: "number" },
      symbol: { type: "string" },
      updatedAt: { type: "string", maxAgeSeconds: 300 },
    },
  },
};
const res = (body: unknown, over: Partial<UpstreamResult> = {}): UpstreamResult => ({
  status: 200, contentType: "application/json; charset=utf-8",
  body: typeof body === "string" ? body : JSON.stringify(body), latencyMs: 5, ...over,
});
const fresh = { symbol: "ADA", price: 0.42, updatedAt: "2026-10-06T11:59:00.000Z" };

describe("ruleHash", () => {
  it("is sha256 over JCS and ignores key order", () => {
    const reordered = { schema: priceRule.schema, contentType: "application/json", version: 1, status: { max: 299, min: 200 } } as RuleDefinition;
    expect(ruleHash(priceRule)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ruleHash(reordered)).toBe(ruleHash(priceRule));
  });
});

describe("compileRule", () => {
  it("passes a response that keeps the promise", () => {
    expect(compileRule(priceRule).check(res(fresh))).toEqual({ pass: true, reasons: [] });
  });
  it("fails {} and names every missing field", () => {
    const v = compileRule(priceRule).check(res({}));
    expect(v.pass).toBe(false);
    expect(v.reasons).toHaveLength(3);
    expect(v.reasons).toEqual(expect.arrayContaining(["/price is missing", "/symbol is missing", "/updatedAt is missing"]));
  });
  it("fails stale data through maxAgeSeconds (ISO string)", () => {
    const v = compileRule(priceRule).check(res({ ...fresh, updatedAt: "2026-10-06T11:00:00.000Z" }));
    expect(v).toEqual({ pass: false, reasons: ["/updatedAt is older than 300s"] });
  });
  it("maxAgeSeconds also accepts epoch seconds", () => {
    const rule: RuleDefinition = { ...priceRule, schema: { type: "object", required: ["ts"], properties: { ts: { type: "number", maxAgeSeconds: 60 } } } };
    const nowS = NOW.getTime() / 1000;
    expect(compileRule(rule).check(res({ ts: nowS - 30 })).pass).toBe(true);
    expect(compileRule(rule).check(res({ ts: nowS - 120 })).reasons).toEqual(["/ts is older than 60s"]);
  });
  it("fails a wrong status, a wrong content type and invalid JSON", () => {
    const c = compileRule(priceRule);
    expect(c.check(res(fresh, { status: 500 })).reasons).toEqual(["status 500 is outside 200-299"]);
    expect(c.check(res(fresh, { contentType: "text/html" })).reasons).toEqual(["content type is text/html, expected application/json"]);
    expect(c.check(res("{nope")).reasons).toEqual(["body is not valid JSON"]);
  });
  it("caches compiled rules by hash", () => {
    const reordered = JSON.parse(JSON.stringify({ status: priceRule.status, version: 1, contentType: "application/json", schema: priceRule.schema })) as RuleDefinition;
    expect(compileRule(reordered)).toBe(compileRule(priceRule));
  });
  it("rejects unknown versions", () => {
    expect(() => compileRule({ ...priceRule, version: 2 } as unknown as RuleDefinition)).toThrow(/version/);
  });
});

describe("inferRule", () => {
  const samples = [
    { symbol: "ADA", price: 0.42, updatedAt: "2026-10-06T11:59:50.000Z", createdAt: "2019-01-01T00:00:00Z", venue: "x" },
    { symbol: "ADA", price: 0.41, updatedAt: "2026-10-06T11:59:55.000Z", createdAt: "2019-01-01T00:00:00Z" },
  ];
  it("requires only fields present in every sample, with observed types", () => {
    const def = inferRule(samples);
    expect(def.status).toEqual({ min: 200, max: 299 });
    expect(def.contentType).toBe("application/json");
    expect(def.schema).toEqual({
      type: "object",
      required: ["createdAt", "price", "symbol", "updatedAt"],
      properties: {
        createdAt: { type: "string" },
        price: { type: "number" },
        symbol: { type: "string" },
        updatedAt: { type: "string", maxAgeSeconds: 300 },
      },
    });
  });
  it("the inferred rule fails the broken deploy ({})", () => {
    expect(compileRule(inferRule(samples)).check(res({})).pass).toBe(false);
  });
  it("leaves the rule unchanged when it already rejects the error sample", () => {
    expect(inferRule(samples, { error: "unknown symbol" })).toEqual(inferRule(samples));
  });
  it("tightens a loose rule with the error sample's distinctive keys", () => {
    const def = inferRule([{}, {}], { error: "x" });
    expect(compileRule(def).check(res({ error: "x" })).pass).toBe(false);
    expect(compileRule(def).check(res({})).pass).toBe(true);
  });
  it("refuses when the error response cannot be told apart", () => {
    expect(() => inferRule([{ a: 1 }], { a: 2 })).toThrow(/would accept the error response/);
  });
  it("types mixed values as a type list and needs at least one sample", () => {
    expect(inferRule([{ v: 1 }, { v: "1" }]).schema).toEqual({
      type: "object", required: ["v"], properties: { v: { type: ["number", "string"] } },
    });
    expect(() => inferRule([])).toThrow(/at least one/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @hirakumi/core exec vitest run test/rules.test.ts`
Expected: FAIL, `Failed to resolve import "../src/rules"`.

- [ ] **Step 4: Implement**

`packages/core/src/fetch.ts` (Task 4 replaces this file with the full version):
```ts
export type UpstreamResult = { status: number; contentType: string | null; body: string; latencyMs: number };
```

`packages/core/src/rules.ts`:
```ts
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { jcs } from "./jcs";
import { sha256Hex } from "./ids";
import type { UpstreamResult } from "./fetch";

export type RuleDefinition = {
  version: 1;
  status: { min: number; max: number };
  contentType: "application/json";
  schema: Record<string, unknown>;
};
export type Verdict = { pass: boolean; reasons: string[] };
export type CompiledRule = { hash: string; check(res: UpstreamResult): Verdict };

export const DEFAULT_MAX_AGE_SECONDS = 300;

/** Age in seconds of an ISO 8601 string or an epoch-seconds number; null when unparseable. */
export function ageSeconds(value: string | number, nowMs: number): number | null {
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? (nowMs - ms) / 1000 : null;
}

const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
ajv.addKeyword({
  keyword: "maxAgeSeconds",
  type: ["string", "number"],
  schemaType: "number",
  errors: false,
  // Runs at validation time, so Date.now() is the moment the response is checked.
  validate: (maxAge: number, data: unknown) => {
    const age = ageSeconds(data as string | number, Date.now());
    return age !== null && age <= maxAge;
  },
});

export function ruleHash(def: RuleDefinition): string {
  return `sha256:${sha256Hex(jcs(def))}`;
}

export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const at = e.instancePath || "/";
    if (e.keyword === "required") {
      return `${e.instancePath}/${(e.params as { missingProperty: string }).missingProperty} is missing`;
    }
    if (e.keyword === "maxAgeSeconds") return `${at} is older than ${String(e.schema)}s`;
    if (e.keyword === "not") return `${at} looks like an error response`;
    return `${at} ${e.message ?? "is invalid"}`;
  });
}

const cache = new Map<string, CompiledRule>();

export function compileRule(def: RuleDefinition): CompiledRule {
  if (def.version !== 1) throw new Error(`unsupported rule version ${String(def.version)}`);
  const hash = ruleHash(def);
  const hit = cache.get(hash);
  if (hit) return hit;
  const validate: ValidateFunction = ajv.compile(def.schema);
  const compiled: CompiledRule = {
    hash,
    check(res: UpstreamResult): Verdict {
      const reasons: string[] = [];
      if (res.status < def.status.min || res.status > def.status.max) {
        reasons.push(`status ${res.status} is outside ${def.status.min}-${def.status.max}`);
      }
      const ct = (res.contentType ?? "").split(";")[0].trim().toLowerCase();
      if (ct !== def.contentType) reasons.push(`content type is ${ct || "missing"}, expected ${def.contentType}`);
      if (reasons.length) return { pass: false, reasons };
      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        return { pass: false, reasons: ["body is not valid JSON"] };
      }
      if (validate(body)) return { pass: true, reasons: [] };
      return { pass: false, reasons: formatSchemaErrors(validate.errors) };
    },
  };
  cache.set(hash, compiled);
  return compiled;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
type JsonKind = "null" | "boolean" | "number" | "string" | "array" | "object";

function kindOf(v: unknown): JsonKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "boolean" || t === "number" || t === "string" || t === "object") return t;
  throw new Error(`not a JSON value: ${t}`);
}

/** JSON Schema that every sample satisfies: required = keys present in all samples. */
export function inferSchema(values: unknown[]): Record<string, unknown> {
  const kinds = [...new Set(values.map(kindOf))].sort();
  if (kinds.length !== 1) return { type: kinds };
  const kind = kinds[0];
  if (kind === "object") {
    const objs = values as Record<string, unknown>[];
    const common = Object.keys(objs[0]).filter((k) => objs.every((o) => Object.hasOwn(o, k))).sort();
    return {
      type: "object",
      required: common,
      properties: Object.fromEntries(common.map((k) => [k, inferSchema(objs.map((o) => o[k]))])),
    };
  }
  if (kind === "array") {
    const items = (values as unknown[][]).flat();
    return items.length ? { type: "array", items: inferSchema(items) } : { type: "array" };
  }
  if (kind === "string") {
    const strings = values as string[];
    const now = Date.now();
    const freshStamp = strings.every((s) => {
      if (!ISO_DATE_TIME.test(s)) return false;
      const age = ageSeconds(s, now);
      return age !== null && Math.abs(age) <= DEFAULT_MAX_AGE_SECONDS;
    });
    return freshStamp ? { type: "string", maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS } : { type: "string" };
  }
  return { type: kind };
}

function acceptsBody(def: RuleDefinition, body: unknown): boolean {
  return compileRule(def).check({ status: 200, contentType: "application/json", body: JSON.stringify(body), latencyMs: 0 }).pass;
}

const isObject = (v: unknown): v is Record<string, unknown> => kindOf(v) === "object";

export function inferRule(samples: unknown[], errorSample?: unknown): RuleDefinition {
  if (samples.length === 0) throw new Error("inferRule needs at least one passing sample");
  const base: RuleDefinition = {
    version: 1,
    status: { min: 200, max: 299 },
    contentType: "application/json",
    schema: inferSchema(samples),
  };
  if (errorSample === undefined || !acceptsBody(base, errorSample)) return base;
  if (isObject(errorSample) && samples.every(isObject)) {
    const seen = new Set(samples.flatMap((s) => Object.keys(s)));
    const distinctive = Object.keys(errorSample).filter((k) => !seen.has(k)).sort();
    if (distinctive.length) {
      const tightened: RuleDefinition = {
        ...base,
        schema: { ...base.schema, not: { anyOf: distinctive.map((k) => ({ required: [k] })) } },
      };
      if (!acceptsBody(tightened, errorSample)) return tightened;
    }
  }
  throw new Error(
    "The promise would accept the error response. Add a passing sample that shows the fields a real answer always has.",
  );
}
```

`packages/core/src/index.ts`:
```ts
export * from "./ids";
export * from "./jcs";
export * from "./hashing";
export * from "./challenge";
export * from "./rules";
export * from "./fetch";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/core exec vitest run test/rules.test.ts && pnpm --filter @hirakumi/core typecheck`
Expected: PASS (15 tests), and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): rule engine with maxAgeSeconds keyword, ruleHash and inferRule" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: SSRF-safe `safeFetch`

**Files:**
- Modify: `packages/core/src/fetch.ts` (full replacement)
- Test: `packages/core/test/fetch.test.ts`

**Interfaces:**
- Consumes: undici `Agent`, `request`; Node `net.BlockList`, `net.isIP`, `dns.lookup`.
- Produces:
  - `export type UpstreamResult` (unchanged)
  - `export class UpstreamBlockedError extends Error {}`
  - `export class UpstreamTimeoutError extends Error {}`
  - `export class UpstreamTooLargeError extends Error {}`
  - `export const UPSTREAM_TIMEOUT_MS = 15_000`, `MAX_REQUEST_BYTES = 262_144`, `MAX_RESPONSE_BYTES = 1_048_576`
  - `export function isBlockedAddress(addr: string): boolean`
  - `export function safeFetch(url: string, init: { method: string; headers?: Record<string, string>; body?: string }, opts?: { timeoutMs?: number; maxBytes?: number }): Promise<UpstreamResult>`

How it works: one keep-alive undici `Agent` whose `connect.lookup` resolves DNS once, rejects the request if **any** address is blocked, and hands those same addresses to the socket. Because the IP is pinned this way, DNS rebinding can't slip in between the check and the connection. IP-literal hosts are checked before dialling. `request()` never follows redirects, and a 3xx answer is refused. The response is streamed with a byte cap. `ALLOW_INSECURE_UPSTREAM=1` permits `http://localhost` and `http://127.0.0.1` only, and is read at call time.

- [ ] **Step 1: Write the failing test**

`packages/core/test/fetch.test.ts`:
```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  isBlockedAddress, safeFetch, UpstreamBlockedError, UpstreamTimeoutError, UpstreamTooLargeError,
} from "../src/fetch";

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ok") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://169.254.169.254/" }); res.end(); return; }
    if (req.url === "/big") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ pad: "x".repeat(5000) })); return; }
    if (req.url === "/slow") { setTimeout(() => { res.writeHead(200); res.end("{}"); }, 1000); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { delete process.env.ALLOW_INSECURE_UPSTREAM; });

describe("isBlockedAddress", () => {
  it.each([
    ["10.1.2.3", true], ["172.20.0.1", true], ["192.168.1.1", true], ["127.0.0.1", true],
    ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true], ["::1", true],
    ["fd00:ec2::254", true], ["fe80::1", true], ["::ffff:127.0.0.1", true], ["not-an-ip", true],
    ["8.8.8.8", false], ["2606:4700:4700::1111", false],
  ])("%s → %s", (addr, blocked) => { expect(isBlockedAddress(addr)).toBe(blocked); });
});

describe("safeFetch blocks", () => {
  it.each([
    ["plain http to a public host", "http://example.com/"],
    ["http localhost without the flag", "http://127.0.0.1:1/"],
    ["https loopback literal", "https://127.0.0.1/"],
    ["https metadata literal", "https://169.254.169.254/latest/meta-data"],
    ["https ipv6 loopback literal", "https://[::1]/"],
    ["https hostname resolving to loopback (DNS check)", "https://localhost:1/"],
    ["credentials in the URL", "https://user:pw@example.com/"],
  ])("%s", async (_name, url) => {
    await expect(safeFetch(url, { method: "GET" })).rejects.toBeInstanceOf(UpstreamBlockedError);
  });
  it("redirects are refused, not followed", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    await expect(safeFetch(`${base}/redirect`, { method: "GET" })).rejects.toBeInstanceOf(UpstreamBlockedError);
  });
});

describe("safeFetch with ALLOW_INSECURE_UPSTREAM=1 (local stubs)", () => {
  it("returns status, content type, body and latency", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    const r = await safeFetch(`${base}/ok`, { method: "GET" });
    expect(r).toMatchObject({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
  it("caps the response size", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    await expect(safeFetch(`${base}/big`, { method: "GET" }, { maxBytes: 1000 })).rejects.toBeInstanceOf(UpstreamTooLargeError);
  });
  it("caps the request size at 256 KB", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    await expect(safeFetch(`${base}/ok`, { method: "POST", body: "x".repeat(262_145) })).rejects.toBeInstanceOf(UpstreamTooLargeError);
  });
  it("times out", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    await expect(safeFetch(`${base}/slow`, { method: "GET" }, { timeoutMs: 100 })).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @hirakumi/core exec vitest run test/fetch.test.ts`
Expected: FAIL, `isBlockedAddress is not a function` / `does not provide an export named 'safeFetch'`.

- [ ] **Step 3: Implement**

`packages/core/src/fetch.ts`:
```ts
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, request, type Dispatcher } from "undici";

export type UpstreamResult = { status: number; contentType: string | null; body: string; latencyMs: number };
export class UpstreamBlockedError extends Error { override name = "UpstreamBlockedError"; }
export class UpstreamTimeoutError extends Error { override name = "UpstreamTimeoutError"; }
export class UpstreamTooLargeError extends Error { override name = "UpstreamTooLargeError"; }

export const UPSTREAM_TIMEOUT_MS = 15_000;
export const MAX_REQUEST_BYTES = 262_144;
export const MAX_RESPONSE_BYTES = 1_048_576;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** True for private, loopback, link-local (incl. 169.254.169.254 metadata), CGNAT, multicast, reserved, or non-IP input. */
export function isBlockedAddress(addr: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) return isBlockedAddress(mapped[1]);
  const family = isIP(addr);
  if (family === 0) return true;
  return blocked.check(addr, family === 6 ? "ipv6" : "ipv4");
}

type LookupCallback = (err: Error | null, address?: string | LookupAddress[], family?: number) => void;
function pinnedLookup(hostname: string, options: { all?: boolean; family?: number }, cb: LookupCallback): void {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => isBlockedAddress(a.address));
    if (bad || addrs.length === 0) {
      return cb(new UpstreamBlockedError(`${hostname} resolves to a blocked address ${bad?.address ?? "(none)"}`));
    }
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

const strictAgent = new Agent({ connect: { lookup: pinnedLookup as unknown as LookupFunction }, keepAliveTimeout: 10_000 });
const localAgent = new Agent({ keepAliveTimeout: 10_000 });

export async function safeFetch(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<UpstreamResult> {
  const timeoutMs = opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UpstreamBlockedError(`not a valid URL: ${url}`);
  }
  const insecureOk =
    process.env.ALLOW_INSECURE_UPSTREAM === "1" &&
    u.protocol === "http:" &&
    (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !insecureOk) {
    throw new UpstreamBlockedError(`only https upstreams are allowed (got ${u.protocol}//${u.host})`);
  }
  if (u.username || u.password) throw new UpstreamBlockedError("credentials in the URL are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!insecureOk && isIP(host) !== 0 && isBlockedAddress(host)) throw new UpstreamBlockedError(`blocked address ${host}`);
  if (init.body !== undefined && Buffer.byteLength(init.body) > MAX_REQUEST_BYTES) {
    throw new UpstreamTooLargeError("request body is over 256 KB");
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const started = performance.now();
  try {
    const res = await request(u, {
      method: init.method.toUpperCase() as Dispatcher.HttpMethod,
      headers: init.headers,
      body: init.body,
      dispatcher: insecureOk ? localAgent : strictAgent,
      signal,
    });
    if (res.statusCode >= 300 && res.statusCode < 400) {
      res.body.destroy();
      throw new UpstreamBlockedError(`redirects are not followed (status ${res.statusCode})`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) {
        res.body.destroy();
        throw new UpstreamTooLargeError(`response is over ${maxBytes} bytes`);
      }
      chunks.push(chunk as Buffer);
    }
    const ct = res.headers["content-type"];
    return {
      status: res.statusCode,
      contentType: Array.isArray(ct) ? (ct[0] ?? null) : (ct ?? null),
      body: Buffer.concat(chunks).toString("utf8"),
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    if (err instanceof UpstreamBlockedError || err instanceof UpstreamTooLargeError) throw err;
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof UpstreamBlockedError) throw cause;
    if (signal.aborted) throw new UpstreamTimeoutError(`upstream did not answer within ${timeoutMs} ms`);
    throw err;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/core exec vitest run && pnpm --filter @hirakumi/core typecheck`
Expected: PASS (all core tests), typecheck exits 0. If the `https://localhost:1/` case fails with `ECONNREFUSED` instead of `UpstreamBlockedError`, undici didn't pass `connect.lookup` through to `tls.connect`. Check with `grep -n "lookup\|\.\.\.options" node_modules/.pnpm/undici@7.30.0/node_modules/undici/lib/core/connect.js`. Expected: `tls.connect({ … ...options …})`. If the spread is missing, construct the agent with `connect: (opts, cb) => buildConnector({ lookup: pinnedLookup })(opts, cb)` using `buildConnector` from `undici`.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): SSRF-safe safeFetch with pinned DNS, no redirects and size/time caps" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `@hirakumi/db` typed helpers for the gateway

**Files:**
- Create: `packages/db/src/gateway.ts`
- Modify: `packages/db/package.json` (add `@hirakumi/core`), `packages/db/src/index.ts`
- Test: `packages/db/test/gateway.test.ts`

**Interfaces:**
- Consumes: `Sql`, `createTestDb` (Task 1); `RuleDefinition`, `newId` (Tasks 2–3).
- Produces (all `export`ed from `@hirakumi/db`):
  - Types: `ApiState`, `Health = "healthy" | "down"`, `ApiRow`, `OperationRow`, `RuleRow`, `PackRow`, `ApiBundle`, `CreditStatus`, `Reservation`, `PendingPayment`, `CallInsert`, `JobStatus`, `JobRow`, `JobInsert`, `HealthEventReason`
  - `loadApiBundle(sql, apiId): Promise<ApiBundle | null>`
  - `insertPendingToken(sql, t: { id; apiId; packId; tokenHash; remaining; paymentPayloadHash; txHash: string | null }): Promise<{ inserted: true; id: string } | { inserted: false; id: string; status: CreditStatus }>`
  - `activateTokenByPayment(sql, paymentPayloadHash, txHash: string | null, payer: string | null): Promise<boolean>`
  - `activateTokenById(sql, id): Promise<boolean>`
  - `reserveCredit(sql, apiId, tokenHash): Promise<Reservation>`
  - `releaseCredit(sql, tokenId): Promise<void>`
  - `markExhaustedIfEmpty(sql, tokenId): Promise<void>`
  - `listPendingPayments(sql, minAgeSeconds): Promise<PendingPayment[]>`
  - `insertCall(sql, c: CallInsert): Promise<string>`
  - `insertJob(sql, j: JobInsert)`, `getJob(sql, apiId, jobId)`, `listJobsAwaitingPayment(sql)`, `listUnsubmittedPasses(sql)`, `claimJob(sql, id): Promise<boolean>`, `storeJobOutput(sql, id, output, outputHash)`, `markJobCompleted(sql, id)`, `failJob(sql, id, reasons)`, `expireJob(sql, id)`, `resetInterruptedJobs(sql): Promise<number>`
  - `listMonitoredApiIds(sql): Promise<string[]>`, `loadProbeInputs(sql, apiId): Promise<{ op_id: string; input: unknown }[]>`, `touchHealthCheck(sql, apiId)`, `recordHealthTransition(sql, apiId, from: Health, to: Health, reasons: HealthEventReason[])`
  - `getRuleByHash(sql, hash): Promise<(RuleRow & { created_at: Date }) | null>`
  - `getActiveHttpChallenge(sql, apiId): Promise<{ id: string; token: string } | null>`, `consumeChallenge(sql, id, proof: Record<string, unknown>): Promise<boolean>`

- [ ] **Step 1: Add the core dependency**

In `packages/db/package.json`, set `"dependencies": { "@hirakumi/core": "workspace:*", "postgres": "3.4.9" }`, then run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`packages/db/test/gateway.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing";
import {
  activateTokenByPayment, claimJob, insertJob, insertPendingToken, listJobsAwaitingPayment, loadApiBundle,
  markExhaustedIfEmpty, recordHealthTransition, releaseCredit, reserveCredit,
} from "../src/gateway";

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
  const sql = db.sql;
  await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1qseller')`;
  await sql`insert into apis (id, seller_id, name, origin, openapi_url, state) values ('api_a', 'sel_a', 'Price', 'https://p.example', 'https://p.example/openapi.json', 'live')`;
  await sql`insert into operations (id, api_id, op_id, method, path, input_schema, enabled) values ('op_a', 'api_a', 'getPrice', 'GET', '/price', '{"type":"object"}', true)`;
  await sql`insert into rules (id, operation_id, version, definition, hash) values ('rule_1', 'op_a', 1, '{"v":1}', 'sha256:1'), ('rule_2', 'op_a', 2, '{"v":2}', 'sha256:2')`;
  await sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values ('pk_a', 'api_a', 100, 2000000, 1000000)`;
});
afterEach(async () => { await db.drop(); });

const pending = (over: Partial<Parameters<typeof insertPendingToken>[1]> = {}) => ({
  id: "ct_1", apiId: "api_a", packId: "pk_a", tokenHash: "th1", remaining: 1, paymentPayloadHash: "pp1", txHash: null, ...over,
});

describe("loadApiBundle", () => {
  it("joins the seller address and keeps only the latest rule version per operation", async () => {
    const b = await loadApiBundle(db.sql, "api_a");
    expect(b?.api.pay_to).toBe("addr_test1qseller");
    expect(b?.rules.map((r) => r.id)).toEqual(["rule_2"]);
    expect(b?.packs[0]).toMatchObject({ id: "pk_a", calls: 100, price_micros: "2000000" });
    expect(await loadApiBundle(db.sql, "api_missing")).toBeNull();
  });
});

describe("credit tokens", () => {
  it("insertPendingToken is idempotent on the payment hash", async () => {
    expect(await insertPendingToken(db.sql, pending())).toEqual({ inserted: true, id: "ct_1" });
    expect(await insertPendingToken(db.sql, pending({ id: "ct_2", tokenHash: "th2" }))).toEqual({ inserted: false, id: "ct_1", status: "pending" });
  });
  it("a pending token cannot be reserved; activation flips it once", async () => {
    await insertPendingToken(db.sql, pending());
    expect(await reserveCredit(db.sql, "api_a", "th1")).toEqual({ ok: false, reason: "pending" });
    expect(await activateTokenByPayment(db.sql, "pp1", "tx1", "addr_test1qbuyer")).toBe(true);
    expect(await activateTokenByPayment(db.sql, "pp1", "tx1", "addr_test1qbuyer")).toBe(false);
    expect(await reserveCredit(db.sql, "api_a", "th1")).toEqual({ ok: true, tokenId: "ct_1", remainingAfter: 0 });
    expect(await reserveCredit(db.sql, "other_api", "th1")).toEqual({ ok: false, reason: "not_found" });
  });
  it("reserveCredit race: 20 concurrent callers, exactly one wins the last credit", async () => {
    await insertPendingToken(db.sql, pending());
    await activateTokenByPayment(db.sql, "pp1", "tx1", null);
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveCredit(db.sql, "api_a", "th1")));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "exhausted")).toHaveLength(19);
  });
  it("release revives a token another request already marked exhausted (no lost credit)", async () => {
    await insertPendingToken(db.sql, pending({ remaining: 2 }));
    await activateTokenByPayment(db.sql, "pp1", "tx1", null);
    const a = await reserveCredit(db.sql, "api_a", "th1");
    const b = await reserveCredit(db.sql, "api_a", "th1");
    expect(a.ok && b.ok).toBe(true);
    await markExhaustedIfEmpty(db.sql, "ct_1");          // A passed: remaining 0 → exhausted
    await releaseCredit(db.sql, "ct_1");                 // B failed: give its credit back
    const [row] = await db.sql<{ status: string; remaining: number }[]>`select status, remaining from credit_tokens where id = 'ct_1'`;
    expect(row).toEqual({ status: "active", remaining: 1 });
    expect(await reserveCredit(db.sql, "api_a", "th1")).toMatchObject({ ok: true, remainingAfter: 0 });
  });
});

describe("jobs and health", () => {
  it("claimJob succeeds exactly once", async () => {
    await insertJob(db.sql, { id: "job_1", apiId: "api_a", identifierFromPurchaser: "aabbccddeeff0011", input: { symbol: "ADA" },
      inputHash: "ih", blockchainIdentifier: "bc1", payByTime: new Date(Date.now() + 60_000), submitResultTime: new Date(Date.now() + 120_000) });
    expect((await listJobsAwaitingPayment(db.sql)).map((j) => j.id)).toEqual(["job_1"]);
    const claims = await Promise.all([claimJob(db.sql, "job_1"), claimJob(db.sql, "job_1")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it("recordHealthTransition updates apis and writes one health_events row atomically", async () => {
    await recordHealthTransition(db.sql, "api_a", "healthy", "down", [{ op: "getPrice", reason: "/price is missing", since: "2026-10-06T12:00:00.000Z" }]);
    const [api] = await db.sql<{ health: string; health_checked_at: Date | null }[]>`select health, health_checked_at from apis where id = 'api_a'`;
    expect(api.health).toBe("down");
    expect(api.health_checked_at).not.toBeNull();
    const events = await db.sql<{ from_health: string; to_health: string; reasons: unknown }[]>`select from_health, to_health, reasons from health_events`;
    expect(events).toEqual([{ from_health: "healthy", to_health: "down", reasons: [{ op: "getPrice", reason: "/price is missing", since: "2026-10-06T12:00:00.000Z" }] }]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @hirakumi/db exec vitest run test/gateway.test.ts`
Expected: FAIL, `Failed to resolve import "../src/gateway"`.

- [ ] **Step 4: Implement**

`packages/db/src/gateway.ts`:
```ts
import type postgres from "postgres";
import { newId, type RuleDefinition } from "@hirakumi/core";
import type { Sql } from "./client";

const json = (sql: Sql, v: unknown) => sql.json(v as postgres.JSONValue);

export type ApiState =
  | "intake" | "parsed" | "described" | "endpoints_confirmed" | "ownership_verified"
  | "rule_built" | "priced" | "registering" | "live" | "retired";
export type Health = "healthy" | "down";
export type ApiRow = {
  id: string; seller_id: string; name: string; origin: string; path_prefix: string; state: ApiState;
  health: Health; health_checked_at: Date | null; escrow_op_id: string | null; agent_identifier: string | null;
  pay_to: string;
};
export type OperationRow = {
  id: string; api_id: string; op_id: string; method: string; path: string;
  input_schema: Record<string, unknown>; description: string | null; enabled: boolean;
};
export type RuleRow = { id: string; operation_id: string; version: number; definition: RuleDefinition; hash: string; plain_english: string | null };
export type PackRow = { id: string; api_id: string; calls: number; price_micros: string; escrow_price_micros: string };
export type ApiBundle = { api: ApiRow; operations: OperationRow[]; rules: RuleRow[]; packs: PackRow[] };

export async function loadApiBundle(sql: Sql, apiId: string): Promise<ApiBundle | null> {
  const [api] = await sql<ApiRow[]>`
    select a.id, a.seller_id, a.name, a.origin, a.path_prefix, a.state, a.health, a.health_checked_at,
           a.escrow_op_id, a.agent_identifier, s.cardano_addr as pay_to
    from apis a join sellers s on s.id = a.seller_id
    where a.id = ${apiId}`;
  if (!api) return null;
  const operations = await sql<OperationRow[]>`
    select id, api_id, op_id, method, path, input_schema, description, enabled
    from operations where api_id = ${apiId} order by op_id`;
  const rules = await sql<RuleRow[]>`
    select distinct on (r.operation_id) r.id, r.operation_id, r.version, r.definition, r.hash, r.plain_english
    from rules r join operations o on o.id = r.operation_id
    where o.api_id = ${apiId}
    order by r.operation_id, r.version desc`;
  const packs = await sql<PackRow[]>`
    select id, api_id, calls, price_micros::text as price_micros, escrow_price_micros::text as escrow_price_micros
    from packs where api_id = ${apiId} order by price_micros, id`;
  return { api, operations, rules, packs };
}

// ---------------------------------------------------------------- credit tokens

export type CreditStatus = "pending" | "active" | "exhausted" | "revoked";

export async function insertPendingToken(
  sql: Sql,
  t: { id: string; apiId: string; packId: string; tokenHash: string; remaining: number; paymentPayloadHash: string; txHash: string | null },
): Promise<{ inserted: true; id: string } | { inserted: false; id: string; status: CreditStatus }> {
  const rows = await sql<{ id: string }[]>`
    insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash, tx_hash)
    values (${t.id}, ${t.apiId}, ${t.packId}, ${t.tokenHash}, 'pending', ${t.remaining}, ${t.paymentPayloadHash}, ${t.txHash})
    on conflict (payment_payload_hash) do nothing
    returning id`;
  if (rows.length) return { inserted: true, id: rows[0].id };
  const [existing] = await sql<{ id: string; status: CreditStatus }[]>`
    select id, status from credit_tokens where payment_payload_hash = ${t.paymentPayloadHash}`;
  return { inserted: false, id: existing.id, status: existing.status };
}

export async function activateTokenByPayment(sql: Sql, paymentPayloadHash: string, txHash: string | null, payer: string | null): Promise<boolean> {
  const rows = await sql`
    update credit_tokens
    set status = 'active', tx_hash = coalesce(${txHash}::text, tx_hash), payer = coalesce(${payer}::text, payer)
    where payment_payload_hash = ${paymentPayloadHash} and status = 'pending'
    returning id`;
  return rows.length === 1;
}

export async function activateTokenById(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`update credit_tokens set status = 'active' where id = ${id} and status = 'pending' returning id`;
  return rows.length === 1;
}

export type Reservation =
  | { ok: true; tokenId: string; remainingAfter: number }
  | { ok: false; reason: "not_found" | "pending" | "exhausted" | "revoked" };

/** One atomic conditional decrement. Concurrent callers can never take the same credit. */
export async function reserveCredit(sql: Sql, apiId: string, tokenHash: string): Promise<Reservation> {
  const [row] = await sql<{ id: string; remaining: number }[]>`
    update credit_tokens set remaining = remaining - 1
    where token_hash = ${tokenHash} and api_id = ${apiId} and status = 'active' and remaining > 0
    returning id, remaining`;
  if (row) return { ok: true, tokenId: row.id, remainingAfter: row.remaining };
  const [t] = await sql<{ status: CreditStatus }[]>`
    select status from credit_tokens where token_hash = ${tokenHash} and api_id = ${apiId}`;
  if (!t) return { ok: false, reason: "not_found" };
  if (t.status === "pending") return { ok: false, reason: "pending" };
  if (t.status === "revoked") return { ok: false, reason: "revoked" };
  return { ok: false, reason: "exhausted" };
}

/** Gives a reserved credit back. Revives a token another request already flipped to exhausted. */
export async function releaseCredit(sql: Sql, tokenId: string): Promise<void> {
  await sql`
    update credit_tokens
    set remaining = remaining + 1, status = case when status = 'exhausted' then 'active' else status end
    where id = ${tokenId}`;
}

export async function markExhaustedIfEmpty(sql: Sql, tokenId: string): Promise<void> {
  await sql`update credit_tokens set status = 'exhausted' where id = ${tokenId} and status = 'active' and remaining = 0`;
}

export type PendingPayment = { id: string; tx_hash: string; pay_to: string; price_micros: string };

export async function listPendingPayments(sql: Sql, minAgeSeconds: number): Promise<PendingPayment[]> {
  return sql<PendingPayment[]>`
    select ct.id, ct.tx_hash, s.cardano_addr as pay_to, p.price_micros::text as price_micros
    from credit_tokens ct
    join packs p on p.id = ct.pack_id
    join apis a on a.id = ct.api_id
    join sellers s on s.id = a.seller_id
    where ct.status = 'pending' and ct.tx_hash is not null
      and ct.created_at < now() - (${minAgeSeconds} * interval '1 second')
    order by ct.created_at
    limit 50`;
}

// ---------------------------------------------------------------- calls (evidence)

export type CallInsert = {
  kind: "credit" | "escrow" | "probe" | "preview";
  apiId: string; opId: string;
  execution: "upstream_ok" | "upstream_error" | "timeout" | "blocked";
  verdict: "pass" | "fail" | "n/a";
  reasons: string[];
  creditTokenId?: string | null; jobId?: string | null; blockchainId?: string | null; ruleId?: string | null;
  latencyMs?: number | null; inputHash?: string | null; outputHash?: string | null;
};

export async function insertCall(sql: Sql, c: CallInsert): Promise<string> {
  const id = newId("call");
  await sql`
    insert into calls (id, kind, credit_token_id, job_id, blockchain_id, api_id, op_id, rule_id, execution, verdict,
                       verdict_reasons, latency_ms, input_hash, output_hash)
    values (${id}, ${c.kind}, ${c.creditTokenId ?? null}, ${c.jobId ?? null}, ${c.blockchainId ?? null}, ${c.apiId}, ${c.opId},
            ${c.ruleId ?? null}, ${c.execution}, ${c.verdict}, ${json(sql, c.reasons)}, ${c.latencyMs ?? null},
            ${c.inputHash ?? null}, ${c.outputHash ?? null})`;
  return id;
}

// ---------------------------------------------------------------- jobs (MIP-003)

export type JobStatus = "awaiting_payment" | "running" | "completed" | "failed" | "expired";
export type JobRow = {
  id: string; api_id: string; identifier_from_purchaser: string; input: unknown; input_hash: string;
  blockchain_identifier: string | null; status: JobStatus; output: string | null; output_hash: string | null;
  failure_reasons: string[] | null; pay_by_time: Date | null; submit_result_time: Date | null; created_at: Date;
};
export type JobInsert = {
  id: string; apiId: string; identifierFromPurchaser: string; input: unknown; inputHash: string;
  blockchainIdentifier: string; payByTime: Date; submitResultTime: Date;
};

export async function insertJob(sql: Sql, j: JobInsert): Promise<void> {
  await sql`
    insert into jobs (id, api_id, identifier_from_purchaser, input, input_hash, blockchain_identifier, status, pay_by_time, submit_result_time)
    values (${j.id}, ${j.apiId}, ${j.identifierFromPurchaser}, ${json(sql, j.input)}, ${j.inputHash}, ${j.blockchainIdentifier},
            'awaiting_payment', ${j.payByTime}, ${j.submitResultTime})`;
}

export async function getJob(sql: Sql, apiId: string, jobId: string): Promise<JobRow | null> {
  const [row] = await sql<JobRow[]>`select * from jobs where id = ${jobId} and api_id = ${apiId}`;
  return row ?? null;
}

export async function listJobsAwaitingPayment(sql: Sql): Promise<JobRow[]> {
  return sql<JobRow[]>`select * from jobs where status = 'awaiting_payment' order by created_at limit 100`;
}

export async function listUnsubmittedPasses(sql: Sql): Promise<JobRow[]> {
  return sql<JobRow[]>`select * from jobs where status = 'running' and output_hash is not null order by created_at limit 100`;
}

export async function claimJob(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`update jobs set status = 'running' where id = ${id} and status = 'awaiting_payment' returning id`;
  return rows.length === 1;
}

export async function storeJobOutput(sql: Sql, id: string, output: string, outputHash: string): Promise<void> {
  await sql`update jobs set output = ${output}, output_hash = ${outputHash} where id = ${id} and status = 'running'`;
}

export async function markJobCompleted(sql: Sql, id: string): Promise<void> {
  await sql`update jobs set status = 'completed' where id = ${id} and status = 'running'`;
}

export async function failJob(sql: Sql, id: string, reasons: string[]): Promise<void> {
  await sql`update jobs set status = 'failed', failure_reasons = ${json(sql, reasons)} where id = ${id} and status in ('awaiting_payment', 'running')`;
}

export async function expireJob(sql: Sql, id: string): Promise<void> {
  await sql`update jobs set status = 'expired' where id = ${id} and status = 'awaiting_payment'`;
}

/** After a crash: a job that was running without an output never reached upstream's answer; run it again. */
export async function resetInterruptedJobs(sql: Sql): Promise<number> {
  const rows = await sql`update jobs set status = 'awaiting_payment' where status = 'running' and output_hash is null returning id`;
  return rows.length;
}

// ---------------------------------------------------------------- health

export type HealthEventReason = { op: string; reason: string; since: string | null };

export async function listMonitoredApiIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from apis where state in ('registering', 'live') order by id`;
  return rows.map((r) => r.id);
}

export async function loadProbeInputs(sql: Sql, apiId: string): Promise<{ op_id: string; input: unknown }[]> {
  return sql<{ op_id: string; input: unknown }[]>`
    select o.op_id, t.input from test_inputs t join operations o on o.id = t.operation_id
    where o.api_id = ${apiId} and o.enabled order by o.op_id, t.id`;
}

export async function touchHealthCheck(sql: Sql, apiId: string): Promise<void> {
  await sql`update apis set health_checked_at = now() where id = ${apiId}`;
}

export async function recordHealthTransition(sql: Sql, apiId: string, from: Health, to: Health, reasons: HealthEventReason[]): Promise<void> {
  await sql`
    with upd as (update apis set health = ${to}, health_checked_at = now() where id = ${apiId} returning id)
    insert into health_events (api_id, from_health, to_health, reasons)
    select id, ${from}, ${to}, ${json(sql, reasons)} from upd`;
}

// ---------------------------------------------------------------- rules and challenges

export async function getRuleByHash(sql: Sql, hash: string): Promise<(RuleRow & { created_at: Date }) | null> {
  const [row] = await sql<(RuleRow & { created_at: Date })[]>`
    select id, operation_id, version, definition, hash, plain_english, created_at from rules where hash = ${hash}`;
  return row ?? null;
}

export async function getActiveHttpChallenge(sql: Sql, apiId: string): Promise<{ id: string; token: string } | null> {
  const [row] = await sql<{ id: string; token: string }[]>`
    select id, token from challenges
    where api_id = ${apiId} and kind = 'http' and consumed_at is null and expires_at > now()
    order by expires_at desc limit 1`;
  return row ?? null;
}

export async function consumeChallenge(sql: Sql, id: string, proof: Record<string, unknown>): Promise<boolean> {
  const rows = await sql`
    update challenges set consumed_at = now(), proof = ${json(sql, proof)}
    where id = ${id} and consumed_at is null returning id`;
  return rows.length === 1;
}
```

`packages/db/src/index.ts`:
```ts
export * from "./client";
export * from "./migrate";
export * from "./gateway";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/db test && pnpm --filter @hirakumi/db typecheck`
Expected: PASS (migrate 3, gateway 7), typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): typed gateway helpers with atomic credit reserve/release" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Gateway package, config and `HealthTracker`

**Files:**
- Create: `apps/gateway/package.json`, `apps/gateway/tsconfig.json`, `apps/gateway/vitest.config.ts`, `apps/gateway/src/config.ts`, `apps/gateway/src/health.ts`
- Test: `apps/gateway/test/config.test.ts`, `apps/gateway/test/health.test.ts`

**Interfaces:**
- Consumes: env vars from `.env.example`.
- Produces:
  - `export type HealthThresholds = { failsToDown: number; passesToHeal: number }`
  - `export type GatewayConfig = { port: number; publicBaseUrl: string; internalToken: string; demoMode: boolean; facilitatorUrl: string; databaseUrl: string; probeIntervalMs: number; thresholds: HealthThresholds; l1Confirmations: number; upstreamTimeoutMs: number; escrow: { payByMs: number; submitResultMs: number }; blockfrostProjectId: string | null; masumi: { baseUrl: string; token: string } | null }`
  - `export function loadConfig(env?: NodeJS.ProcessEnv): GatewayConfig`
  - `export type HealthState = "healthy" | "down"`
  - `export type HealthReason = { op: string; reason: string }`
  - `export type HealthSnapshot = { health: HealthState; checkedAt: Date | null; lastReasons: HealthReason[]; failingSince: Date | null }`
  - `export type HealthTransition = { apiId: string; from: HealthState; to: HealthState; reasons: HealthReason[]; failingSince: Date | null; at: Date }`
  - `export class HealthTracker { constructor(t: HealthThresholds); seed(apiId, health, checkedAt): void; reset(apiId): void; get(apiId): HealthSnapshot | undefined; record(apiId, passed: boolean, reasons: HealthReason[], at?: Date): HealthTransition | null }`
  - `export function estimatedDowntimeSeconds(c: Pick<GatewayConfig, "probeIntervalMs" | "thresholds">): number`

- [ ] **Step 1: Create the package and install**

`apps/gateway/package.json`:
```json
{
  "name": "@hirakumi/gateway",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=../../.env src/main.ts",
    "start": "tsx src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@hirakumi/core": "workspace:*",
    "@hirakumi/db": "workspace:*",
    "@x402/cardano": "2.26.0",
    "@x402/core": "2.26.0",
    "@x402/express": "2.26.0",
    "ajv": "8.20.0",
    "express": "4.21.2"
  },
  "devDependencies": {
    "@types/express": "4.17.25",
    "@types/node": "22.20.5",
    "@types/supertest": "7.2.1",
    "@x402/fetch": "2.26.0",
    "supertest": "7.3.1",
    "tsx": "4.23.15",
    "typescript": "5.9.3",
    "vitest": "3.2.7"
  }
}
```

`apps/gateway/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "scripts", "vitest.config.ts"] }
```

`apps/gateway/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 30_000,
    env: { ALLOW_INSECURE_UPSTREAM: "1" },
  },
});
```

```bash
mkdir -p apps/gateway/src apps/gateway/test apps/gateway/scripts && pnpm install
pnpm why @x402/core -r | grep -E "@x402/core [0-9]" | sort -u   # expect only "@x402/core 2.26.0"
```

- [ ] **Step 2: Write the failing tests**

`apps/gateway/test/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { estimatedDowntimeSeconds, loadConfig } from "../src/config";

const env = {
  DATABASE_URL: "postgres://x", PUBLIC_BASE_URL: "https://api.hirakumi.app/", INTERNAL_TOKEN: "change-me-32-bytes",
  FACILITATOR_URL: "https://x402.preprod.dev.ecosyseng.cf-deployments.org",
};

describe("loadConfig", () => {
  it("production defaults: 120s, 3 fails, 2 passes, l1Confirmations 0, 15s upstream", () => {
    const c = loadConfig({ ...env, DEMO_MODE: "0" });
    expect(c).toMatchObject({
      port: 4021, publicBaseUrl: "https://api.hirakumi.app", demoMode: false, probeIntervalMs: 120_000,
      thresholds: { failsToDown: 3, passesToHeal: 2 }, l1Confirmations: 0, upstreamTimeoutMs: 15_000,
      blockfrostProjectId: null, masumi: null,
    });
    expect(estimatedDowntimeSeconds(c)).toBe(240);
  });
  it("demo mode: 10s, 2 fails, 2 passes", () => {
    const c = loadConfig({ ...env, DEMO_MODE: "1", GATEWAY_PORT: "5000" });
    expect(c).toMatchObject({ port: 5000, demoMode: true, probeIntervalMs: 10_000, thresholds: { failsToDown: 2, passesToHeal: 2 } });
    expect(estimatedDowntimeSeconds(c)).toBe(20);
  });
  it("names a missing variable", () => {
    expect(() => loadConfig({ ...env, FACILITATOR_URL: "" })).toThrow(/FACILITATOR_URL/);
  });
  it("reads Masumi settings only when both URL and token are set", () => {
    expect(loadConfig({ ...env, PAYMENT_SERVICE_URL: "http://ps/api/v1" }).masumi).toBeNull();
    expect(loadConfig({ ...env, PAYMENT_SERVICE_URL: "http://ps/api/v1", PAYMENT_SERVICE_TOKEN: "t" }).masumi)
      .toEqual({ baseUrl: "http://ps/api/v1", token: "t" });
  });
});
```

`apps/gateway/test/health.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { HealthTracker } from "../src/health";

const r = [{ op: "getPrice", reason: "/price is missing" }];
const t = (s: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, s));

describe("HealthTracker (demo thresholds 2/2)", () => {
  it("goes Down after 2 consecutive failures and remembers when failing started", () => {
    const h = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    expect(h.record("api_a", false, r, t(0))).toBeNull();
    const tr = h.record("api_a", false, r, t(10));
    expect(tr).toEqual({ apiId: "api_a", from: "healthy", to: "down", reasons: r, failingSince: t(0), at: t(10) });
    expect(h.get("api_a")).toMatchObject({ health: "down", checkedAt: t(10), lastReasons: r, failingSince: t(0) });
  });
  it("a pass in between resets the failure run", () => {
    const h = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    h.record("api_a", false, r, t(0));
    h.record("api_a", true, [], t(10));
    expect(h.record("api_a", false, r, t(20))).toBeNull();
    expect(h.get("api_a")?.health).toBe("healthy");
  });
  it("needs 2 consecutive passes to come back", () => {
    const h = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    h.record("api_a", false, r, t(0));
    h.record("api_a", false, r, t(10));
    expect(h.record("api_a", true, [], t(20))).toBeNull();
    expect(h.record("api_a", true, [], t(30))).toEqual({ apiId: "api_a", from: "down", to: "healthy", reasons: [], failingSince: null, at: t(30) });
    expect(h.get("api_a")).toMatchObject({ health: "healthy", failingSince: null, lastReasons: [] });
  });
  it("production thresholds need 3 failures", () => {
    const h = new HealthTracker({ failsToDown: 3, passesToHeal: 2 });
    h.record("api_a", false, r); h.record("api_a", false, r);
    expect(h.get("api_a")?.health).toBe("healthy");
    expect(h.record("api_a", false, r)?.to).toBe("down");
  });
  it("seed keeps DB state unless already tracked; reset forgets", () => {
    const h = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
    h.seed("api_a", "down", t(0));
    h.seed("api_a", "healthy", null);
    expect(h.get("api_a")?.health).toBe("down");
    h.reset("api_a");
    expect(h.get("api_a")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/config.test.ts test/health.test.ts`
Expected: FAIL, `Failed to resolve import "../src/config"` / `"../src/health"`.

- [ ] **Step 4: Implement**

`apps/gateway/src/health.ts`:
```ts
export type HealthState = "healthy" | "down";
export type HealthThresholds = { failsToDown: number; passesToHeal: number };
export type HealthReason = { op: string; reason: string };
export type HealthSnapshot = { health: HealthState; checkedAt: Date | null; lastReasons: HealthReason[]; failingSince: Date | null };
export type HealthTransition = {
  apiId: string; from: HealthState; to: HealthState; reasons: HealthReason[]; failingSince: Date | null; at: Date;
};

type Entry = { snap: HealthSnapshot; fails: number; passes: number };

/** In-memory health per API. Reads are O(1), so 503 answers never touch the DB or upstream. */
export class HealthTracker {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly t: HealthThresholds) {}

  seed(apiId: string, health: HealthState, checkedAt: Date | null): void {
    if (this.entries.has(apiId)) return;
    this.entries.set(apiId, { snap: { health, checkedAt, lastReasons: [], failingSince: null }, fails: 0, passes: 0 });
  }

  reset(apiId: string): void {
    this.entries.delete(apiId);
  }

  get(apiId: string): HealthSnapshot | undefined {
    return this.entries.get(apiId)?.snap;
  }

  record(apiId: string, passed: boolean, reasons: HealthReason[], at: Date = new Date()): HealthTransition | null {
    let e = this.entries.get(apiId);
    if (!e) {
      e = { snap: { health: "healthy", checkedAt: null, lastReasons: [], failingSince: null }, fails: 0, passes: 0 };
      this.entries.set(apiId, e);
    }
    e.snap.checkedAt = at;
    if (passed) {
      e.passes += 1;
      e.fails = 0;
      e.snap.lastReasons = [];
      if (e.snap.health === "down" && e.passes >= this.t.passesToHeal) {
        e.snap.health = "healthy";
        e.snap.failingSince = null;
        return { apiId, from: "down", to: "healthy", reasons: [], failingSince: null, at };
      }
      if (e.snap.health === "healthy") e.snap.failingSince = null;
      return null;
    }
    e.fails += 1;
    e.passes = 0;
    e.snap.lastReasons = reasons;
    if (e.fails === 1 && e.snap.health === "healthy") e.snap.failingSince = at;
    if (e.snap.health === "healthy" && e.fails >= this.t.failsToDown) {
      e.snap.health = "down";
      return { apiId, from: "healthy", to: "down", reasons, failingSince: e.snap.failingSince, at };
    }
    return null;
  }
}
```

`apps/gateway/src/config.ts`:
```ts
import type { HealthThresholds } from "./health";

export type { HealthThresholds } from "./health";
export type GatewayConfig = {
  port: number;
  publicBaseUrl: string;
  internalToken: string;
  demoMode: boolean;
  facilitatorUrl: string;
  databaseUrl: string;
  probeIntervalMs: number;
  thresholds: HealthThresholds;
  l1Confirmations: number;
  upstreamTimeoutMs: number;
  escrow: { payByMs: number; submitResultMs: number };
  blockfrostProjectId: string | null;
  masumi: { baseUrl: string; token: string } | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const required = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`Set ${k} in the environment (see .env.example)`);
    return v;
  };
  const demoMode = env.DEMO_MODE === "1";
  const internalToken = required("INTERNAL_TOKEN");
  if (internalToken.length < 16) throw new Error("INTERNAL_TOKEN must be at least 16 characters");
  const psUrl = env.PAYMENT_SERVICE_URL?.trim();
  const psToken = env.PAYMENT_SERVICE_TOKEN?.trim();
  return {
    port: Number(env.GATEWAY_PORT ?? 4021),
    publicBaseUrl: required("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    internalToken,
    demoMode,
    facilitatorUrl: required("FACILITATOR_URL"),
    databaseUrl: required("DATABASE_URL"),
    probeIntervalMs: demoMode ? 10_000 : 120_000,
    thresholds: demoMode ? { failsToDown: 2, passesToHeal: 2 } : { failsToDown: 3, passesToHeal: 2 },
    // Spec §8: block inclusion. Task 0 confirms the hosted facilitator range includes 0.
    l1Confirmations: 0,
    upstreamTimeoutMs: 15_000,
    // Masumi payment-service rules (x402-cardano-demo/masumi/src/masumi.ts): pay-by ≥ 5 min before
    // submit-result; submit-result ≥ 15 min ahead. Demo uses the shortest safe values.
    escrow: demoMode ? { payByMs: 10 * 60_000, submitResultMs: 20 * 60_000 } : { payByMs: 30 * 60_000, submitResultMs: 60 * 60_000 },
    blockfrostProjectId: env.BLOCKFROST_PROJECT_ID?.trim() || null,
    masumi: psUrl && psToken ? { baseUrl: psUrl, token: psToken } : null,
  };
}

export function estimatedDowntimeSeconds(c: Pick<GatewayConfig, "probeIntervalMs" | "thresholds">): number {
  return Math.ceil(c.probeIntervalMs / 1000) * c.thresholds.passesToHeal;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/config.test.ts test/health.test.ts`
Expected: PASS (config 4, health 5).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway pnpm-lock.yaml
git commit -m "feat(gateway): package, config and in-memory health state machine" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Registry cache, upstream request builder, `runOperation`, test helpers

**Files:**
- Create: `apps/gateway/src/masumi-port.ts`, `apps/gateway/src/registry.ts`, `apps/gateway/src/upstream.ts`, `apps/gateway/src/deps.ts`, `apps/gateway/test/helpers.ts`
- Test: `apps/gateway/test/registry.test.ts`, `apps/gateway/test/upstream.test.ts`

**Interfaces:**
- Consumes: `loadApiBundle`, `ApiRow`, `OperationRow`, `RuleRow`, `PackRow`, `Sql` (`@hirakumi/db`); `compileRule`, `formatSchemaErrors`, `jcs`, `safeFetch`, `UpstreamBlockedError`, `UpstreamTimeoutError`, `UpstreamTooLargeError`, `CompiledRule`, `UpstreamResult` (`@hirakumi/core`); `HealthTracker`, `GatewayConfig`.
- Produces:
  - `export type PaymentState = "WaitingForPayment" | "FundsLocked" | "ResultSubmitted" | "RefundRequested" | "Disputed" | "Withdrawn" | "RefundWithdrawn" | "Other"`
  - `export type PaymentRequestResult = { blockchainIdentifier: string; payByTime: Date; submitResultTime: Date; unlockTime: Date; externalDisputeUnlockTime: Date; sellerVKey: string }`
  - `export type MasumiPort = { createPaymentRequest(p: { agentIdentifier: string; inputHash: string; identifierFromPurchaser: string; submitResultTime: Date; payByTime: Date }): Promise<PaymentRequestResult>; getPaymentState(blockchainIdentifier: string): Promise<PaymentState>; submitResult(blockchainIdentifier: string, resultHash: string): Promise<void> }`
  - `export type InputCheck = { ok: true; value: Record<string, unknown> } | { ok: false; reasons: string[] }`
  - `export type LoadedOp = { row: OperationRow; ruleRow: RuleRow | null; rule: CompiledRule | null; validateInput(input: unknown): InputCheck }`
  - `export type LoadedApi = { api: ApiRow; ops: Map<string, LoadedOp>; packs: PackRow[] }` (ops keyed by `op_id`)
  - `export class ApiRegistry { constructor(sql: Sql, health: HealthTracker); get(apiId: string, opts?: { fresh?: boolean }): Promise<LoadedApi | null>; invalidate(apiId: string): void }`
  - `export function compileInputValidator(schema: Record<string, unknown>): (input: unknown) => InputCheck`
  - `export function escrowOperation(l: LoadedApi): LoadedOp | undefined`
  - `export function primaryRule(l: LoadedApi): RuleRow | null`
  - `export function buildUpstreamRequest(api: Pick<ApiRow, "origin" | "path_prefix">, op: Pick<OperationRow, "method" | "path">, input: Record<string, unknown>): { url: string; init: { method: string; headers: Record<string, string>; body?: string } }`
  - `export function normalizeMip003Input(inputData: unknown): Record<string, unknown> | null`
  - `export type Execution = "upstream_ok" | "upstream_error" | "timeout" | "blocked"`
  - `export type OperationOutcome = { execution: Execution; verdict: "pass" | "fail" | "n/a"; reasons: string[]; result: UpstreamResult | null; latencyMs: number }`
  - `export function runOperation(api: Pick<ApiRow, "origin" | "path_prefix">, op: LoadedOp, input: Record<string, unknown>, opts: { timeoutMs: number; probe?: boolean }): Promise<OperationOutcome>`
  - `export type AppDeps = { sql: Sql; config: GatewayConfig; registry: ApiRegistry; health: HealthTracker; facilitator: FacilitatorClient; masumi: MasumiPort | null }`
  - Test helpers: `startStubUpstream()`, `seedLiveApi()`, `insertActiveToken()`, `FakeFacilitator`, `FakeMasumi`, `testConfig()`, `PRICE_RULE`, `PRICE_INPUT_SCHEMA`

A registry entry holds a compiled rule only when `compileRule(definition).hash` equals the stored `rules.hash`. If they differ, the published hash wouldn't describe the rule being enforced, so the operation is treated as having no published promise (503 `promise_not_published`).

- [ ] **Step 1: Write the test helpers**

`apps/gateway/test/helpers.ts`:
```ts
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { newBearerToken, newId, ruleHash, sha256Hex, type RuleDefinition } from "@hirakumi/core";
import type { Sql } from "@hirakumi/db";
import type { GatewayConfig } from "../src/config";
import type { MasumiPort, PaymentRequestResult, PaymentState } from "../src/masumi-port";

export type StubMode = "ok" | "empty" | "stale" | "error500" | "slow" | "html";
export type StubUpstream = {
  origin: string;
  setMode(m: StubMode): void;
  setChallenge(path: string, body: string): void;
  hits(): number;
  lastHeaders(): http.IncomingHttpHeaders | null;
  close(): Promise<void>;
};

/** Plain-HTTP seller on 127.0.0.1 (allowed by ALLOW_INSECURE_UPSTREAM=1 in vitest.config.ts). */
export async function startStubUpstream(): Promise<StubUpstream> {
  let mode: StubMode = "ok";
  let hits = 0;
  let last: http.IncomingHttpHeaders | null = null;
  const files = new Map<string, string>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname.startsWith("/.well-known/hirakumi/")) {
      const body = files.get(url.pathname);
      if (body === undefined) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/plain" }); res.end(body); return;
    }
    if (url.pathname !== "/price") { res.writeHead(404); res.end(); return; }
    hits += 1;
    last = req.headers;
    const symbol = url.searchParams.get("symbol") ?? "ADA";
    const ok = () => JSON.stringify({ symbol, price: 0.42, updatedAt: new Date().toISOString() });
    switch (mode) {
      case "ok": res.writeHead(200, { "content-type": "application/json" }); res.end(ok()); return;
      case "empty": res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return;
      case "stale":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ symbol, price: 0.42, updatedAt: new Date(Date.now() - 3_600_000).toISOString() })); return;
      case "error500": res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"boom"}'); return;
      case "html": res.writeHead(200, { "content-type": "text/html" }); res.end("<html></html>"); return;
      case "slow": setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(ok()); }, 1500); return;
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    setMode: (m) => { mode = m; },
    setChallenge: (path, body) => { files.set(path, body); },
    hits: () => hits,
    lastHeaders: () => last,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export const PRICE_INPUT_SCHEMA = {
  type: "object",
  properties: { symbol: { type: "string", minLength: 2, maxLength: 10, description: "Ticker, e.g. ADA" } },
  required: ["symbol"],
  additionalProperties: false,
};

export const PRICE_RULE: RuleDefinition = {
  version: 1,
  status: { min: 200, max: 299 },
  contentType: "application/json",
  schema: {
    type: "object",
    required: ["price", "symbol", "updatedAt"],
    properties: { price: { type: "number" }, symbol: { type: "string" }, updatedAt: { type: "string", maxAgeSeconds: 300 } },
  },
};

export type Seeded = {
  sellerId: string; apiId: string; operationId: string; opId: string; ruleId: string; ruleHash: string;
  packId: string; payTo: string;
};

export async function seedLiveApi(
  sql: Sql,
  origin: string,
  opts: { health?: "healthy" | "down"; state?: string; calls?: number; agentIdentifier?: string | null } = {},
): Promise<Seeded> {
  const sellerId = newId("sel"), apiId = newId("api"), operationId = newId("op"), ruleId = newId("rule"), packId = newId("pk");
  const payTo = `addr_test1q${randomBytes(20).toString("hex")}`;
  const hash = ruleHash(PRICE_RULE);
  await sql`insert into sellers (id, cardano_addr) values (${sellerId}, ${payTo})`;
  await sql`
    insert into apis (id, seller_id, name, origin, openapi_url, state, health, escrow_op_id, agent_identifier)
    values (${apiId}, ${sellerId}, 'Price API', ${origin}, ${`${origin}/openapi.json`}, ${opts.state ?? "live"},
            ${opts.health ?? "healthy"}, ${operationId}, ${opts.agentIdentifier === undefined ? "agent_test_1" : opts.agentIdentifier})`;
  await sql`
    insert into operations (id, api_id, op_id, method, path, input_schema, enabled, side_effects_confirmed_none)
    values (${operationId}, ${apiId}, 'getPrice', 'GET', '/price', ${sql.json(PRICE_INPUT_SCHEMA)}, true, true)`;
  await sql`
    insert into rules (id, operation_id, version, definition, hash, plain_english)
    values (${ruleId}, ${operationId}, 1, ${sql.json(PRICE_RULE as never)}, ${hash},
            'The answer has a symbol, a number price and a timestamp from the last 5 minutes.')`;
  await sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values (${packId}, ${apiId}, ${opts.calls ?? 100}, 2000000, 1000000)`;
  await sql`insert into test_inputs (id, operation_id, input) values (${newId("ti")}, ${operationId}, ${sql.json({ symbol: "ADA" })})`;
  return { sellerId, apiId, operationId, opId: "getPrice", ruleId, ruleHash: hash, packId, payTo };
}

/** Inserts an already-settled credit token and returns the raw bearer token. */
export async function insertActiveToken(sql: Sql, s: Seeded, remaining = 100, status = "active"): Promise<{ token: string; id: string }> {
  const token = newBearerToken();
  const id = newId("ct");
  await sql`
    insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash)
    values (${id}, ${s.apiId}, ${s.packId}, ${sha256Hex(token)}, ${status}, ${remaining}, ${sha256Hex(id)})`;
  return { token, id };
}

export class FakeFacilitator implements FacilitatorClient {
  settleMode: "success" | "fail" = "success";
  verifyCalls = 0;
  settleCalls = 0;
  async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    return { isValid: true, payer: "addr_test1qbuyer" };
  }
  async settle(_p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls += 1;
    if (this.settleMode === "fail") {
      return { success: false, errorReason: "exact_cardano_settlement_failed", transaction: "", network: r.network };
    }
    return { success: true, transaction: "ab".repeat(32), network: r.network, payer: "addr_test1qbuyer" };
  }
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: "cardano:preprod",
                extra: { assetTransferMethods: ["default"], areFeesSponsored: false, l1Confirmations: { minimum: 0, maximum: 20 } } }],
      extensions: [],
      signers: {},
    };
  }
}

export class FakeMasumi implements MasumiPort {
  state: PaymentState = "WaitingForPayment";
  created: Array<{ agentIdentifier: string; inputHash: string; identifierFromPurchaser: string }> = [];
  submitted: Array<{ blockchainIdentifier: string; resultHash: string }> = [];
  async createPaymentRequest(p: { agentIdentifier: string; inputHash: string; identifierFromPurchaser: string; submitResultTime: Date; payByTime: Date }): Promise<PaymentRequestResult> {
    this.created.push({ agentIdentifier: p.agentIdentifier, inputHash: p.inputHash, identifierFromPurchaser: p.identifierFromPurchaser });
    return {
      blockchainIdentifier: `bc_${randomBytes(8).toString("hex")}`,
      payByTime: p.payByTime,
      submitResultTime: p.submitResultTime,
      unlockTime: new Date(p.submitResultTime.getTime() + 20 * 60_000),
      externalDisputeUnlockTime: new Date(p.submitResultTime.getTime() + 40 * 60_000),
      sellerVKey: "vkey_test",
    };
  }
  async getPaymentState(): Promise<PaymentState> { return this.state; }
  async submitResult(blockchainIdentifier: string, resultHash: string): Promise<void> {
    this.submitted.push({ blockchainIdentifier, resultHash });
  }
}

export function testConfig(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0, publicBaseUrl: "https://gw.test", internalToken: "internal-test-token-0123456789", demoMode: true,
    facilitatorUrl: "http://facilitator.invalid", databaseUrl: "unused", probeIntervalMs: 10_000,
    thresholds: { failsToDown: 2, passesToHeal: 2 }, l1Confirmations: 0, upstreamTimeoutMs: 500,
    escrow: { payByMs: 10 * 60_000, submitResultMs: 20 * 60_000 }, blockfrostProjectId: null, masumi: null,
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/gateway/test/registry.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@hirakumi/db/testing";
import { HealthTracker } from "../src/health";
import { ApiRegistry, escrowOperation, primaryRule } from "../src/registry";
import { seedLiveApi, type Seeded } from "./helpers";

let db: TestDb; let s: Seeded; let health: HealthTracker; let registry: ApiRegistry;
beforeEach(async () => {
  db = await createTestDb();
  s = await seedLiveApi(db.sql, "https://price.example", { health: "down" });
  health = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
  registry = new ApiRegistry(db.sql, health);
});
afterEach(async () => { await db.drop(); });

describe("ApiRegistry", () => {
  it("loads ops by op_id with a compiled rule and seeds health from the DB", async () => {
    const l = await registry.get(s.apiId);
    const op = l?.ops.get("getPrice");
    expect(op?.rule?.hash).toBe(s.ruleHash);
    expect(op?.ruleRow?.id).toBe(s.ruleId);
    expect(l?.packs.map((p) => p.id)).toEqual([s.packId]);
    expect(health.get(s.apiId)?.health).toBe("down");
    expect(escrowOperation(l!)?.row.id).toBe(s.operationId);
    expect(primaryRule(l!)?.hash).toBe(s.ruleHash);
  });
  it("validates input with coercion and reports plain reasons", async () => {
    const op = (await registry.get(s.apiId))!.ops.get("getPrice")!;
    expect(op.validateInput({ symbol: "ADA" })).toEqual({ ok: true, value: { symbol: "ADA" } });
    expect(op.validateInput({})).toEqual({ ok: false, reasons: ["/symbol is missing"] });
    expect(op.validateInput({ symbol: "ADA", x: "1" })).toMatchObject({ ok: false });
  });
  it("drops a rule whose stored hash does not match its definition", async () => {
    await db.sql`update rules set hash = 'sha256:tampered' where id = ${s.ruleId}`;
    const op = (await registry.get(s.apiId, { fresh: true }))!.ops.get("getPrice")!;
    expect(op.rule).toBeNull();
  });
  it("caches until invalidate(), which also forgets in-memory health", async () => {
    await registry.get(s.apiId);
    await db.sql`update packs set price_micros = 3000000 where id = ${s.packId}`;
    expect((await registry.get(s.apiId))!.packs[0].price_micros).toBe("2000000");
    registry.invalidate(s.apiId);
    expect(health.get(s.apiId)).toBeUndefined();
    expect((await registry.get(s.apiId))!.packs[0].price_micros).toBe("3000000");
  });
  it("returns null for unknown APIs and does not cache the miss", async () => {
    expect(await registry.get("api_nope")).toBeNull();
  });
});
```

`apps/gateway/test/upstream.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileRule } from "@hirakumi/core";
import { compileInputValidator, type LoadedOp } from "../src/registry";
import { buildUpstreamRequest, normalizeMip003Input, runOperation } from "../src/upstream";
import { PRICE_INPUT_SCHEMA, PRICE_RULE, startStubUpstream, type StubUpstream } from "./helpers";

let stub: StubUpstream;
beforeAll(async () => { stub = await startStubUpstream(); });
afterAll(async () => { await stub.close(); });

const op = (): LoadedOp => ({
  row: { id: "op_x", api_id: "api_x", op_id: "getPrice", method: "GET", path: "/price", input_schema: PRICE_INPUT_SCHEMA, description: null, enabled: true },
  ruleRow: null,
  rule: compileRule(PRICE_RULE),
  validateInput: compileInputValidator(PRICE_INPUT_SCHEMA),
});

describe("buildUpstreamRequest", () => {
  it("fills path params, sends the rest as query for GET", () => {
    const r = buildUpstreamRequest({ origin: "https://a.example/", path_prefix: "/v1/" }, { method: "get", path: "/price/{symbol}" }, { symbol: "ADA", fiat: "usd" });
    expect(r.url).toBe("https://a.example/v1/price/ADA?fiat=usd");
    expect(r.init).toEqual({ method: "GET", headers: { accept: "application/json", "user-agent": "hirakumi-gateway/0.1" } });
  });
  it("sends a JSON body for POST", () => {
    const r = buildUpstreamRequest({ origin: "https://a.example", path_prefix: "/" }, { method: "POST", path: "/quote" }, { symbol: "ADA" });
    expect(r.url).toBe("https://a.example/quote");
    expect(r.init.body).toBe('{"symbol":"ADA"}');
    expect(r.init.headers["content-type"]).toBe("application/json");
  });
  it("fails on a missing path parameter", () => {
    expect(() => buildUpstreamRequest({ origin: "https://a.example", path_prefix: "/" }, { method: "GET", path: "/p/{id}" }, {})).toThrow(/id/);
  });
});

describe("normalizeMip003Input", () => {
  it("accepts an object or a [{key,value}] list", () => {
    expect(normalizeMip003Input({ symbol: "ADA" })).toEqual({ symbol: "ADA" });
    expect(normalizeMip003Input([{ key: "symbol", value: "ADA" }])).toEqual({ symbol: "ADA" });
    expect(normalizeMip003Input([{ nokey: 1 }])).toBeNull();
    expect(normalizeMip003Input("ADA")).toBeNull();
  });
});

describe("runOperation", () => {
  const api = () => ({ origin: stub.origin, path_prefix: "/" });
  it("pass", async () => {
    stub.setMode("ok");
    const o = await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500 });
    expect(o).toMatchObject({ execution: "upstream_ok", verdict: "pass", reasons: [] });
    expect(JSON.parse(o.result!.body).symbol).toBe("ADA");
  });
  it("rule fail on {}", async () => {
    stub.setMode("empty");
    const o = await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500 });
    expect(o.execution).toBe("upstream_ok");
    expect(o.verdict).toBe("fail");
    expect(o.reasons).toContain("/price is missing");
  });
  it("upstream 5xx is upstream_error", async () => {
    stub.setMode("error500");
    expect(await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500 })).toMatchObject({ execution: "upstream_error", verdict: "fail" });
  });
  it("timeout", async () => {
    stub.setMode("slow");
    expect(await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 200 })).toMatchObject({ execution: "timeout", verdict: "fail", result: null });
  });
  it("blocked origin", async () => {
    expect(await runOperation({ origin: "https://169.254.169.254", path_prefix: "/" }, op(), { symbol: "ADA" }, { timeoutMs: 200 }))
      .toMatchObject({ execution: "blocked", verdict: "n/a" });
  });
  it("probe header is sent only for probes", async () => {
    stub.setMode("ok");
    await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500, probe: true });
    expect(stub.lastHeaders()?.["x-hirakumi-probe"]).toBe("1");
    await runOperation(api(), op(), { symbol: "ADA" }, { timeoutMs: 500 });
    expect(stub.lastHeaders()?.["x-hirakumi-probe"]).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/registry.test.ts test/upstream.test.ts`
Expected: FAIL, `Failed to resolve import "../src/registry"` (and `../src/upstream`, `../src/masumi-port` from helpers).

- [ ] **Step 4: Implement**

`apps/gateway/src/masumi-port.ts`:
```ts
/** The @hirakumi/masumi contract functions with MasumiConfig already bound (see masumi-live.ts, Task 15). */
export type PaymentState =
  | "WaitingForPayment" | "FundsLocked" | "ResultSubmitted" | "RefundRequested"
  | "Disputed" | "Withdrawn" | "RefundWithdrawn" | "Other";

export type PaymentRequestResult = {
  blockchainIdentifier: string; payByTime: Date; submitResultTime: Date; unlockTime: Date;
  externalDisputeUnlockTime: Date; sellerVKey: string;
};

export type MasumiPort = {
  createPaymentRequest(p: {
    agentIdentifier: string; inputHash: string; identifierFromPurchaser: string; submitResultTime: Date; payByTime: Date;
  }): Promise<PaymentRequestResult>;
  getPaymentState(blockchainIdentifier: string): Promise<PaymentState>;
  submitResult(blockchainIdentifier: string, resultHash: string): Promise<void>;
};
```

`apps/gateway/src/registry.ts`:
```ts
import Ajv2020 from "ajv/dist/2020.js";
import { compileRule, formatSchemaErrors, jcs, type CompiledRule } from "@hirakumi/core";
import { loadApiBundle, type ApiRow, type OperationRow, type PackRow, type RuleRow, type Sql } from "@hirakumi/db";
import type { HealthTracker } from "./health";

export type InputCheck = { ok: true; value: Record<string, unknown> } | { ok: false; reasons: string[] };
export type LoadedOp = { row: OperationRow; ruleRow: RuleRow | null; rule: CompiledRule | null; validateInput(input: unknown): InputCheck };
export type LoadedApi = { api: ApiRow; ops: Map<string, LoadedOp>; packs: PackRow[] };

const inputAjv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true });
const validators = new Map<string, (input: unknown) => InputCheck>();

/** Compiled once per distinct schema (keyed by JCS). Validates a clone, so coercion never mutates the caller's object. */
export function compileInputValidator(schema: Record<string, unknown>): (input: unknown) => InputCheck {
  const key = jcs(schema);
  const hit = validators.get(key);
  if (hit) return hit;
  const validate = inputAjv.compile(schema);
  const fn = (input: unknown): InputCheck => {
    const value = structuredClone(input ?? {}) as Record<string, unknown>;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reasons: ["input must be an object"] };
    return validate(value) ? { ok: true, value } : { ok: false, reasons: formatSchemaErrors(validate.errors) };
  };
  validators.set(key, fn);
  return fn;
}

export const REGISTRY_TTL_MS = 60_000;

export class ApiRegistry {
  private readonly cache = new Map<string, { at: number; value: Promise<LoadedApi | null> }>();
  constructor(private readonly sql: Sql, private readonly health: HealthTracker) {}

  get(apiId: string, opts: { fresh?: boolean } = {}): Promise<LoadedApi | null> {
    const hit = this.cache.get(apiId);
    if (hit && !opts.fresh && Date.now() - hit.at < REGISTRY_TTL_MS) return hit.value;
    const value = this.load(apiId);
    this.cache.set(apiId, { at: Date.now(), value });
    value.then(
      (v) => { if (!v) this.cache.delete(apiId); },
      () => { this.cache.delete(apiId); },
    );
    return value;
  }

  /** /internal/apis/:apiId/reload — forget cached rules, prices and in-memory health. */
  invalidate(apiId: string): void {
    this.cache.delete(apiId);
    this.health.reset(apiId);
  }

  private async load(apiId: string): Promise<LoadedApi | null> {
    const b = await loadApiBundle(this.sql, apiId);
    if (!b) return null;
    this.health.seed(b.api.id, b.api.health, b.api.health_checked_at);
    const rulesByOp = new Map(b.rules.map((r) => [r.operation_id, r]));
    const ops = new Map<string, LoadedOp>();
    for (const row of b.operations) {
      const ruleRow = rulesByOp.get(row.id) ?? null;
      let rule: CompiledRule | null = ruleRow ? compileRule(ruleRow.definition) : null;
      if (rule && ruleRow && rule.hash !== ruleRow.hash) {
        console.error(`[registry] rule ${ruleRow.id} hash ${ruleRow.hash} does not match its definition (${rule.hash}); not serving it`);
        rule = null;
      }
      ops.set(row.op_id, { row, ruleRow: rule ? ruleRow : null, rule, validateInput: compileInputValidator(row.input_schema) });
    }
    return { api: b.api, ops, packs: b.packs };
  }
}

/** apis.escrow_op_id names operations.id; an OpenAPI op_id is accepted too. */
export function escrowOperation(l: LoadedApi): LoadedOp | undefined {
  const id = l.api.escrow_op_id;
  if (!id) return undefined;
  for (const op of l.ops.values()) if (op.row.id === id) return op;
  return l.ops.get(id);
}

/** The promise a pack advertises: the escrow operation's rule, else the first enabled operation with one. */
export function primaryRule(l: LoadedApi): RuleRow | null {
  const escrow = escrowOperation(l);
  if (escrow?.ruleRow) return escrow.ruleRow;
  for (const op of l.ops.values()) if (op.row.enabled && op.ruleRow) return op.ruleRow;
  return null;
}
```

`apps/gateway/src/upstream.ts`:
```ts
import { safeFetch, UpstreamBlockedError, UpstreamTimeoutError, UpstreamTooLargeError, type UpstreamResult } from "@hirakumi/core";
import type { ApiRow, OperationRow } from "@hirakumi/db";
import type { LoadedOp } from "./registry";

export function buildUpstreamRequest(
  api: Pick<ApiRow, "origin" | "path_prefix">,
  op: Pick<OperationRow, "method" | "path">,
  input: Record<string, unknown>,
): { url: string; init: { method: string; headers: Record<string, string>; body?: string } } {
  const rest: Record<string, unknown> = { ...input };
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = rest[name];
    if (v === undefined || v === null) throw new Error(`missing path parameter ${name}`);
    delete rest[name];
    return encodeURIComponent(String(v));
  });
  const prefix = api.path_prefix.replace(/\/+$/, "");
  const url = new URL(api.origin.replace(/\/+$/, "") + prefix + path);
  const method = op.method.toUpperCase();
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "hirakumi-gateway/0.1" };
  if (method === "GET" || method === "DELETE" || method === "HEAD") {
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
      else url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    return { url: url.toString(), init: { method, headers } };
  }
  headers["content-type"] = "application/json";
  return { url: url.toString(), init: { method, headers, body: JSON.stringify(rest) } };
}

/** MIP-003 input_data arrives as an object (Sokosumi) or as [{key, value}] (MIP-003 examples). */
export function normalizeMip003Input(inputData: unknown): Record<string, unknown> | null {
  if (Array.isArray(inputData)) {
    const out: Record<string, unknown> = {};
    for (const item of inputData) {
      if (!item || typeof item !== "object" || typeof (item as { key?: unknown }).key !== "string") return null;
      out[(item as { key: string }).key] = (item as { value?: unknown }).value;
    }
    return out;
  }
  if (inputData && typeof inputData === "object") return { ...(inputData as Record<string, unknown>) };
  return null;
}

export type Execution = "upstream_ok" | "upstream_error" | "timeout" | "blocked";
export type OperationOutcome = {
  execution: Execution; verdict: "pass" | "fail" | "n/a"; reasons: string[]; result: UpstreamResult | null; latencyMs: number;
};

export async function runOperation(
  api: Pick<ApiRow, "origin" | "path_prefix">,
  op: LoadedOp,
  input: Record<string, unknown>,
  opts: { timeoutMs: number; probe?: boolean },
): Promise<OperationOutcome> {
  const failVerdict = op.rule ? "fail" : "n/a";
  let req: ReturnType<typeof buildUpstreamRequest>;
  try {
    req = buildUpstreamRequest(api, op.row, input);
  } catch (e) {
    return { execution: "blocked", verdict: "n/a", reasons: [(e as Error).message], result: null, latencyMs: 0 };
  }
  if (opts.probe) req.init.headers["x-hirakumi-probe"] = "1";
  const started = performance.now();
  try {
    const result = await safeFetch(req.url, req.init, { timeoutMs: opts.timeoutMs });
    if (result.status >= 500) {
      return { execution: "upstream_error", verdict: failVerdict, reasons: [`upstream answered ${result.status}`], result, latencyMs: result.latencyMs };
    }
    if (!op.rule) return { execution: "upstream_ok", verdict: "n/a", reasons: [], result, latencyMs: result.latencyMs };
    const v = op.rule.check(result);
    return { execution: "upstream_ok", verdict: v.pass ? "pass" : "fail", reasons: v.reasons, result, latencyMs: result.latencyMs };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - started);
    if (e instanceof UpstreamBlockedError) return { execution: "blocked", verdict: "n/a", reasons: [e.message], result: null, latencyMs };
    if (e instanceof UpstreamTimeoutError) return { execution: "timeout", verdict: failVerdict, reasons: [e.message], result: null, latencyMs };
    if (e instanceof UpstreamTooLargeError) return { execution: "upstream_error", verdict: failVerdict, reasons: [e.message], result: null, latencyMs };
    return { execution: "upstream_error", verdict: failVerdict, reasons: [(e as Error).message], result: null, latencyMs };
  }
}
```

`apps/gateway/src/deps.ts`:
```ts
import type { FacilitatorClient } from "@x402/core/server";
import type { Sql } from "@hirakumi/db";
import type { GatewayConfig } from "./config";
import type { HealthTracker } from "./health";
import type { MasumiPort } from "./masumi-port";
import type { ApiRegistry } from "./registry";

export type AppDeps = {
  sql: Sql;
  config: GatewayConfig;
  registry: ApiRegistry;
  health: HealthTracker;
  facilitator: FacilitatorClient;
  masumi: MasumiPort | null;
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/registry.test.ts test/upstream.test.ts && pnpm --filter @hirakumi/gateway typecheck`
Expected: PASS (registry 5, upstream 10), typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): API registry cache, upstream runner and test helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: App skeleton, credit-gated proxy (400/402/401/503/200/422/502/504) and `/r/:ruleHash`

**Files:**
- Create: `apps/gateway/src/http.ts`, `apps/gateway/src/credits.ts`, `apps/gateway/src/app.ts`
- Modify: `apps/gateway/test/helpers.ts` (append `makeHarness`)
- Test: `apps/gateway/test/credits.test.ts`

**Interfaces:**
- Consumes: `AppDeps`, `ApiRegistry`, `runOperation`, `reserveCredit`, `releaseCredit`, `markExhaustedIfEmpty`, `insertCall`, `getRuleByHash`, `inputHash`, `outputHash`, `sha256Hex`, `USDM_PREPROD_ASSET` (`@x402/cardano`).
- Produces:
  - `export function parseBearer(header: string | undefined): string | null`
  - `export function ruleUrl(cfg: Pick<GatewayConfig, "publicBaseUrl">, hash: string): string`
  - `export function creditsRequiredBody(cfg, loaded: LoadedApi, ruleRow: RuleRow): { error: "credits_required"; packs: Array<{ packId: string; calls: number; price: string; asset: string; buyUrl: string }>; ruleHash: string; ruleUrl: string }`
  - `export function downBody(cfg, snap: HealthSnapshot | undefined): { error: "api_down"; message: string; estimated_downtime_seconds: number; since: string | null }`
  - `export const errorHandler: ErrorRequestHandler`
  - `export function creditsRouter(d: AppDeps): Router`
  - `export function createApp(d: AppDeps): Express`
  - Test helper: `export type Harness = { db: TestDb; sql: Sql; stub: StubUpstream; seeded: Seeded; health: HealthTracker; registry: ApiRegistry; facilitator: FakeFacilitator; masumi: FakeMasumi; config: GatewayConfig; deps: AppDeps; app: Express; close(): Promise<void> }` and `export function makeHarness(opts?: { config?: Partial<GatewayConfig>; seed?: Parameters<typeof seedLiveApi>[2] }): Promise<Harness>`

The order of checks on `/a/:apiId/x/:opId` is: 404 (unknown API, operation or method) → **400** bad input → **503** Down → 503 no promise published → **402** no `Bearer hk_…` → 401 unknown or revoked token → 402 `payment_pending` / `credits_required` → reserve → upstream → **200** / **422** / **502** / **504**. Every failure releases the credit **before** the response is sent.

- [ ] **Step 1: Append the harness to `apps/gateway/test/helpers.ts`**

```ts
// ---- appended in Task 8 ----
import type { Express } from "express";
import { createTestDb, type TestDb } from "@hirakumi/db/testing";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { HealthTracker } from "../src/health";
import { ApiRegistry } from "../src/registry";

export type Harness = {
  db: TestDb; sql: Sql; stub: StubUpstream; seeded: Seeded; health: HealthTracker; registry: ApiRegistry;
  facilitator: FakeFacilitator; masumi: FakeMasumi; config: GatewayConfig; deps: AppDeps; app: Express;
  close(): Promise<void>;
};

export async function makeHarness(
  opts: { config?: Partial<GatewayConfig>; seed?: Parameters<typeof seedLiveApi>[2] } = {},
): Promise<Harness> {
  const db = await createTestDb();
  const stub = await startStubUpstream();
  const seeded = await seedLiveApi(db.sql, stub.origin, opts.seed);
  const config = testConfig(opts.config);
  const health = new HealthTracker(config.thresholds);
  const registry = new ApiRegistry(db.sql, health);
  const facilitator = new FakeFacilitator();
  const masumi = new FakeMasumi();
  const deps: AppDeps = { sql: db.sql, config, registry, health, facilitator, masumi };
  const app = createApp(deps);
  return {
    db, sql: db.sql, stub, seeded, health, registry, facilitator, masumi, config, deps, app,
    async close() { await stub.close(); await db.drop(); },
  };
}
```
Move the new `import` lines to the top of the file with the others. ESM hoists imports anyway, but keep them together for readability.

- [ ] **Step 2: Write the failing test**

`apps/gateway/test/credits.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { inputHash } from "@hirakumi/core";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const path = () => `/a/${h.seeded.apiId}/x/getPrice`;
const remaining = async (id: string) =>
  (await h.sql<{ remaining: number; status: string }[]>`select remaining, status from credit_tokens where id = ${id}`)[0];
const goDown = () => {
  h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "/price is missing" }]);
  h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "/price is missing" }]);
};

describe("routing and input", () => {
  it("404 for an unknown API or operation", async () => {
    expect((await request(h.app).get("/a/api_nope/x/getPrice?symbol=ADA")).status).toBe(404);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/x/nope?symbol=ADA`)).status).toBe(404);
  });
  it("400 for bad input, before anything else", async () => {
    const r = await request(h.app).get(`${path()}?x=1`);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "invalid_input" });
    expect(r.body.reasons).toContain("/symbol is missing");
    expect(h.stub.hits()).toBe(0);
  });
});

describe("no token", () => {
  it("402 with pack offers, rule hash and rule URL", async () => {
    const r = await request(h.app).get(`${path()}?symbol=ADA`);
    expect(r.status).toBe(402);
    expect(r.body).toEqual({
      error: "credits_required",
      packs: [{ packId: h.seeded.packId, calls: 100, price: "2000000", asset: USDM_PREPROD_ASSET,
                buyUrl: `https://gw.test/a/${h.seeded.apiId}/packs/${h.seeded.packId}` }],
      ruleHash: h.seeded.ruleHash,
      ruleUrl: `https://gw.test/r/${h.seeded.ruleHash}`,
    });
    expect(h.stub.hits()).toBe(0);
  });
  it("503 before 402 when the API is Down (no payment asked)", async () => {
    goDown();
    const r = await request(h.app).get(`${path()}?symbol=ADA`);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "api_down", estimated_downtime_seconds: 20 });
  });
});

describe("with a token", () => {
  it("200, one credit used, evidence logged keyed by token id", async () => {
    const t = await insertActiveToken(h.sql, h.seeded);
    const r = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${t.token}`);
    expect(r.status).toBe(200);
    expect(r.headers["x-credits-remaining"]).toBe("99");
    expect(r.body.symbol).toBe("ADA");
    expect(await remaining(t.id)).toEqual({ remaining: 99, status: "active" });
    const [call] = await h.sql<{ kind: string; verdict: string; execution: string; input_hash: string; output_hash: string }[]>`
      select kind, verdict, execution, input_hash, output_hash from calls where credit_token_id = ${t.id}`;
    expect(call).toMatchObject({ kind: "credit", verdict: "pass", execution: "upstream_ok", input_hash: inputHash(t.id, { symbol: "ADA" }) });
    expect(call.output_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each([
    ["empty", 422, "promise_not_met"],
    ["stale", 422, "promise_not_met"],
    ["html", 422, "promise_not_met"],
    ["error500", 502, "upstream_error"],
    ["slow", 504, "upstream_timeout"],
  ] as const)("%s → %i and the credit balance is unchanged", async (mode, status, error) => {
    const t = await insertActiveToken(h.sql, h.seeded);
    h.stub.setMode(mode);
    const r = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${t.token}`);
    expect(r.status).toBe(status);
    expect(r.body.error).toBe(error);
    expect(r.headers["x-credits-remaining"]).toBe("100");
    expect(await remaining(t.id)).toEqual({ remaining: 100, status: "active" });
  });
  it("422 names the failing fields", async () => {
    const t = await insertActiveToken(h.sql, h.seeded);
    h.stub.setMode("empty");
    const r = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${t.token}`);
    expect(r.body.reasons).toEqual(expect.arrayContaining(["/price is missing", "/symbol is missing", "/updatedAt is missing"]));
  });
  it("401 for an unknown token, 402 payment_pending for an unsettled one", async () => {
    const unknown = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer hk_${"A".repeat(43)}`);
    expect(unknown.status).toBe(401);
    const p = await insertActiveToken(h.sql, h.seeded, 100, "pending");
    const pending = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${p.token}`);
    expect(pending.status).toBe(402);
    expect(pending.body.error).toBe("payment_pending");
    expect(h.stub.hits()).toBe(0);
  });
  it("last credit race over HTTP: exactly one 200, the rest 402, token exhausted", async () => {
    const t = await insertActiveToken(h.sql, h.seeded, 1);
    const rs = await Promise.all(Array.from({ length: 6 }, () =>
      request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${t.token}`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 402 && r.body.error === "credits_required")).toHaveLength(5);
    expect(await remaining(t.id)).toEqual({ remaining: 0, status: "exhausted" });
  });
  it("503 while Down even with credits; no credit used", async () => {
    const t = await insertActiveToken(h.sql, h.seeded);
    goDown();
    const r = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${t.token}`);
    expect(r.status).toBe(503);
    expect(await remaining(t.id)).toEqual({ remaining: 100, status: "active" });
  });
});

describe("/r/:ruleHash", () => {
  it("returns the rule JSON and plain English", async () => {
    const r = await request(h.app).get(`/r/${h.seeded.ruleHash}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ruleHash: h.seeded.ruleHash, version: 1, plain_english: expect.stringContaining("symbol") });
    expect(r.body.definition.schema.required).toEqual(["price", "symbol", "updatedAt"]);
    expect((await request(h.app).get("/r/sha256:nope")).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/credits.test.ts`
Expected: FAIL, `Failed to resolve import "../src/app"`.

- [ ] **Step 4: Implement**

`apps/gateway/src/http.ts`:
```ts
import type { ErrorRequestHandler } from "express";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import type { RuleRow } from "@hirakumi/db";
import { estimatedDowntimeSeconds, type GatewayConfig } from "./config";
import type { HealthSnapshot } from "./health";
import type { LoadedApi } from "./registry";

export function parseBearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(hk_[A-Za-z0-9_-]{43})$/.exec(header?.trim() ?? "");
  return m ? m[1] : null;
}

export function ruleUrl(cfg: Pick<GatewayConfig, "publicBaseUrl">, hash: string): string {
  return `${cfg.publicBaseUrl}/r/${hash}`;
}

export function creditsRequiredBody(cfg: Pick<GatewayConfig, "publicBaseUrl">, loaded: LoadedApi, ruleRow: RuleRow) {
  return {
    error: "credits_required" as const,
    packs: loaded.packs.map((p) => ({
      packId: p.id, calls: p.calls, price: p.price_micros, asset: USDM_PREPROD_ASSET,
      buyUrl: `${cfg.publicBaseUrl}/a/${loaded.api.id}/packs/${p.id}`,
    })),
    ruleHash: ruleRow.hash,
    ruleUrl: ruleUrl(cfg, ruleRow.hash),
  };
}

export function downBody(cfg: Pick<GatewayConfig, "probeIntervalMs" | "thresholds">, snap: HealthSnapshot | undefined) {
  return {
    error: "api_down" as const,
    message: "This API is Down right now. Nothing was charged and no credit was used.",
    estimated_downtime_seconds: estimatedDowntimeSeconds(cfg),
    since: snap?.failingSince?.toISOString() ?? null,
  };
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const e = err as { type?: string };
  if (e.type === "entity.parse.failed") { res.status(400).json({ error: "invalid_json" }); return; }
  if (e.type === "entity.too.large") { res.status(413).json({ error: "input_too_large", message: "Inputs are limited to 256 KB." }); return; }
  console.error("[gateway]", err);
  if (!res.headersSent) res.status(500).json({ error: "internal_error" });
};
```

`apps/gateway/src/credits.ts`:
```ts
import { Router } from "express";
import { inputHash, outputHash, sha256Hex } from "@hirakumi/core";
import { insertCall, markExhaustedIfEmpty, releaseCredit, reserveCredit } from "@hirakumi/db";
import type { AppDeps } from "./deps";
import { creditsRequiredBody, downBody, parseBearer } from "./http";
import { runOperation, type OperationOutcome } from "./upstream";

export function creditsRouter(d: AppDeps): Router {
  const r = Router();
  r.all("/a/:apiId/x/:opId", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded || loaded.api.state !== "live") { res.status(404).json({ error: "api_not_found" }); return; }
      const op = loaded.ops.get(req.params.opId);
      if (!op || !op.row.enabled) { res.status(404).json({ error: "operation_not_found" }); return; }
      if (req.method !== op.row.method.toUpperCase()) {
        res.status(405).set("allow", op.row.method.toUpperCase()).json({ error: "method_not_allowed" }); return;
      }
      const checked = op.validateInput(req.method === "GET" ? req.query : req.body);
      if (!checked.ok) { res.status(400).json({ error: "invalid_input", reasons: checked.reasons }); return; }
      const snap = d.health.get(loaded.api.id);
      if (snap?.health === "down") { res.status(503).json(downBody(d.config, snap)); return; }
      if (!op.rule || !op.ruleRow) { res.status(503).json({ error: "promise_not_published" }); return; }

      const bearer = parseBearer(req.header("authorization"));
      if (!bearer) { res.status(402).json(creditsRequiredBody(d.config, loaded, op.ruleRow)); return; }
      const reservation = await reserveCredit(d.sql, loaded.api.id, sha256Hex(bearer));
      if (!reservation.ok) {
        if (reservation.reason === "not_found" || reservation.reason === "revoked") {
          res.status(401).json({ error: "invalid_token" }); return;
        }
        res.status(402).json({
          ...creditsRequiredBody(d.config, loaded, op.ruleRow),
          error: reservation.reason === "pending" ? "payment_pending" : "credits_required",
        });
        return;
      }

      const tokenId = reservation.tokenId;
      let outcome: OperationOutcome;
      try {
        outcome = await runOperation(loaded.api, op, checked.value, { timeoutMs: d.config.upstreamTimeoutMs });
        await insertCall(d.sql, {
          kind: "credit", creditTokenId: tokenId, apiId: loaded.api.id, opId: op.row.op_id, ruleId: op.ruleRow.id,
          execution: outcome.execution, verdict: outcome.verdict, reasons: outcome.reasons, latencyMs: outcome.latencyMs,
          inputHash: inputHash(tokenId, checked.value),
          outputHash: outcome.result ? outputHash(tokenId, outcome.result.body) : null,
        });
      } catch (e) {
        await releaseCredit(d.sql, tokenId);
        throw e;
      }

      if (outcome.execution === "upstream_ok" && outcome.verdict === "pass" && outcome.result) {
        if (reservation.remainingAfter === 0) await markExhaustedIfEmpty(d.sql, tokenId);
        res.status(200)
          .set("x-credits-remaining", String(reservation.remainingAfter))
          .type(outcome.result.contentType ?? "application/json")
          .send(outcome.result.body);
        return;
      }

      await releaseCredit(d.sql, tokenId);
      res.set("x-credits-remaining", String(reservation.remainingAfter + 1));
      if (outcome.execution === "timeout") { res.status(504).json({ error: "upstream_timeout", reasons: outcome.reasons }); return; }
      if (outcome.execution === "upstream_ok") { res.status(422).json({ error: "promise_not_met", reasons: outcome.reasons }); return; }
      res.status(502).json({ error: "upstream_error", reasons: outcome.reasons });
    } catch (e) {
      next(e);
    }
  });
  return r;
}
```

`apps/gateway/src/app.ts`:
```ts
import express, { type Express } from "express";
import { getRuleByHash } from "@hirakumi/db";
import { creditsRouter } from "./credits";
import type { AppDeps } from "./deps";
import { errorHandler } from "./http";

export function createApp(d: AppDeps): Express {
  const app = express();
  app.set("trust proxy", true); // Caddy terminates TLS; x402 resource URLs must say https
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  app.use(creditsRouter(d));
  app.get("/r/:ruleHash", async (req, res, next) => {
    try {
      const rule = await getRuleByHash(d.sql, req.params.ruleHash);
      if (!rule) { res.status(404).json({ error: "rule_not_found" }); return; }
      res.set("cache-control", "public, max-age=31536000, immutable").json({
        ruleHash: rule.hash, version: rule.version, definition: rule.definition,
        plain_english: rule.plain_english, created_at: rule.created_at,
      });
    } catch (e) { next(e); }
  });
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/credits.test.ts && pnpm --filter @hirakumi/gateway typecheck`
Expected: PASS (15 tests), typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): credit-gated proxy with atomic reserve/release and rule check" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Pack purchase over x402 with a pending→active credit token

**Files:**
- Create: `apps/gateway/src/packs.ts`
- Modify: `apps/gateway/src/app.ts`
- Test: `apps/gateway/test/packs.test.ts`

**Interfaces:**
- Consumes:
  - From `@x402/express`: `paymentMiddleware(routes: RoutesConfig, server: x402ResourceServer, paywallConfig?, paywall?, syncFacilitatorOnStart = true)` and `x402ResourceServer`.
  - From `@x402/core/server`: `RoutesConfig`, `HTTPRequestContext`.
  - From `@x402/core/http`: `decodePaymentSignatureHeader(header): PaymentPayload` (tests also use `decodePaymentRequiredHeader`, `encodePaymentSignatureHeader`).
  - From `@x402/cardano/exact/server`: `ExactCardanoScheme`.
  - From `@x402/cardano`: `USDM_PREPROD_ASSET`, `decodeCardanoTransaction(base64).txHash`.
  - `x402ResourceServer#onAfterSettle(hook: (ctx: SettleResultContext) => Promise<void>)`, where `ctx.paymentPayload.payload`, `ctx.result.transaction` and `ctx.result.payer` are available.
  - `x402ResourceServer#onSettleFailure(hook: (ctx: SettleFailureContext) => Promise<void | {recovered…}>)`, where `ctx.error` is available.
  - `insertPendingToken`, `activateTokenByPayment`.
- Produces:
  - `export const PACK_ROUTE = "POST /a/:apiId/packs/:packId"`
  - `export function paymentPayloadHash(payload: unknown): string` (`sha256Hex(jcs(payload))`; credit_tokens.payment_payload_hash)
  - `export function packRouter(d: AppDeps): Router`
  - HTTP: `POST /a/:apiId/packs/:packId`
    - Unpaid: 402 with x402 `PAYMENT-REQUIRED` (`exact`, `cardano:preprod`, `asset = USDM_PREPROD_ASSET`, `amount = price_micros`, `payTo = seller addr`, `extra ⊇ {apiId, packId, calls, ruleHash, ruleUrl, confirmationPolicy:{l1Confirmations}}`).
    - Paid: 200 `{ token, credits, apiId, tokenId }`, or 409 `payment_already_used`.
    - Before any payment: 404, or 503 when Down.

Why the payload hash links the handler to the hook: both see the same signed payment. The handler decodes the `PAYMENT-SIGNATURE` header and the hook receives `ctx.paymentPayload`. `sha256(jcs(payload.payload))` is the identity of the signed transaction and nonce, already `UNIQUE` in the schema. The handler also stores the tx hash decoded from the signed transaction, so the reconciler (Task 14) can activate a token whose settlement outcome was unknown. Why any 4xx is safe: `@x402/express` 2.26.0 cancels settlement whenever the handler's status is ≥ 400 (verified in Task 0 Step 6).

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/packs.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const packPath = () => `/a/${h.seeded.apiId}/packs/${h.seeded.packId}`;

async function offer() {
  const unpaid = await request(h.app).post(packPath());
  expect(unpaid.status).toBe(402);
  const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
  return { unpaid, required, accepted: required.accepts[0] };
}
async function pay(nonce = "nonce-1") {
  const { required, accepted } = await offer();
  const header = encodePaymentSignatureHeader({
    x402Version: required.x402Version, resource: required.resource, accepted,
    payload: { transaction: "dGVzdA==", nonce },
  });
  return { header, res: await request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", header) };
}
const tokens = () => h.sql<{ status: string; remaining: number; tx_hash: string | null; payer: string | null }[]>`
  select status, remaining, tx_hash, payer from credit_tokens`;

describe("pack offer", () => {
  it("402 offers tUSDM to the seller's verified address with pack metadata and l1Confirmations 0", async () => {
    const { unpaid, required, accepted } = await offer();
    expect(required.x402Version).toBe(2);
    expect(accepted).toMatchObject({ scheme: "exact", network: "cardano:preprod", asset: USDM_PREPROD_ASSET, amount: "2000000", payTo: h.seeded.payTo });
    expect(accepted.extra).toMatchObject({
      apiId: h.seeded.apiId, packId: h.seeded.packId, calls: 100, ruleHash: h.seeded.ruleHash,
      ruleUrl: `https://gw.test/r/${h.seeded.ruleHash}`, confirmationPolicy: { l1Confirmations: 0 },
    });
    expect(unpaid.body).toMatchObject({ error: "payment_required", calls: 100, ruleHash: h.seeded.ruleHash });
    expect(h.facilitator.verifyCalls).toBe(0);
  });
  it("404 for an unknown pack; 503 and no x402 offer when the API is Down", async () => {
    expect((await request(h.app).post(`/a/${h.seeded.apiId}/packs/pk_nope`)).status).toBe(404);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    const r = await request(h.app).post(packPath());
    expect(r.status).toBe(503);
    expect(r.headers["payment-required"]).toBeUndefined();
  });
});

describe("pack purchase", () => {
  it("pays, settles, activates the token via onAfterSettle, and the token buys calls", async () => {
    const { res } = await pay();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ credits: 100, apiId: h.seeded.apiId });
    expect(res.body.token).toMatch(/^hk_[A-Za-z0-9_-]{43}$/);
    expect(h.facilitator.settleCalls).toBe(1);
    expect(await tokens()).toEqual([{ status: "active", remaining: 100, tx_hash: "ab".repeat(32), payer: "addr_test1qbuyer" }]);
    const call = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${res.body.token}`);
    expect(call.status).toBe(200);
    expect(call.headers["x-credits-remaining"]).toBe("99");
  });
  it("settle failure leaves the token pending, the buyer never sees it, and it cannot be used", async () => {
    h.facilitator.settleMode = "fail";
    const { res } = await pay();
    expect(res.status).toBe(402);
    expect(res.body.token).toBeUndefined();
    expect(await tokens()).toEqual([{ status: "pending", remaining: 100, tx_hash: null, payer: null }]);
  });
  it("a replayed payment gets 409, mints no second token and is not settled twice", async () => {
    const first = await pay("same");
    expect(first.res.status).toBe(200);
    const replay = await request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", first.header);
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("payment_already_used");
    expect(h.facilitator.settleCalls).toBe(1);
    expect(await tokens()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/packs.test.ts`
Expected: FAIL. The first test gets `expected 404 to be 402` because no pack route is mounted yet.

- [ ] **Step 3: Implement**

`apps/gateway/src/packs.ts`:
```ts
import { Router, type RequestHandler } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { HTTPRequestContext, RoutesConfig } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { USDM_PREPROD_ASSET, decodeCardanoTransaction } from "@x402/cardano";
import { jcs, newBearerToken, newId, sha256Hex } from "@hirakumi/core";
import { activateTokenByPayment, insertPendingToken, type PackRow } from "@hirakumi/db";
import type { AppDeps } from "./deps";
import { downBody, ruleUrl } from "./http";
import { primaryRule, type LoadedApi } from "./registry";

export const PACK_ROUTE = "POST /a/:apiId/packs/:packId";
const PACK_PATH = /^\/a\/([^/]+)\/packs\/([^/]+)$/;
const NETWORK = "cardano:preprod" as const;

export function paymentPayloadHash(payload: unknown): string {
  return sha256Hex(jcs(payload));
}

function txHashOf(payload: Record<string, unknown>): string | null {
  try {
    return decodeCardanoTransaction(String(payload.transaction)).txHash;
  } catch {
    return null;
  }
}

async function resolvePack(d: AppDeps, path: string): Promise<{ loaded: LoadedApi; pack: PackRow }> {
  const m = PACK_PATH.exec(path);
  if (!m) throw new Error(`not a pack route: ${path}`);
  const loaded = await d.registry.get(m[1]);
  const pack = loaded?.packs.find((p) => p.id === m[2]);
  if (!loaded || !pack) throw new Error(`unknown pack ${m[2]} for ${m[1]}`);
  if (!loaded.api.pay_to.startsWith("addr_test1")) throw new Error(`seller address for ${m[1]} is not a preprod address`);
  return { loaded, pack };
}

function packExtra(d: AppDeps, loaded: LoadedApi, pack: PackRow): Record<string, unknown> {
  const rule = primaryRule(loaded);
  if (!rule) throw new Error(`no published promise for ${loaded.api.id}`);
  return { apiId: loaded.api.id, packId: pack.id, calls: pack.calls, ruleHash: rule.hash, ruleUrl: ruleUrl(d.config, rule.hash) };
}

export function packRouter(d: AppDeps): Router {
  const server = new x402ResourceServer(d.facilitator).register(NETWORK, new ExactCardanoScheme());
  server.onAfterSettle(async (ctx) => {
    if (!ctx.result.success) return;
    const activated = await activateTokenByPayment(
      d.sql, paymentPayloadHash(ctx.paymentPayload.payload), ctx.result.transaction || null, ctx.result.payer ?? null,
    );
    console.log(`[packs] settled tx=${ctx.result.transaction} token activated=${activated}`);
  });
  server.onSettleFailure(async (ctx) => {
    console.warn(`[packs] settlement failed, credit token stays pending: ${ctx.error.message}`);
  });

  const routes: RoutesConfig = {
    [PACK_ROUTE]: {
      accepts: {
        scheme: "exact",
        network: NETWORK,
        payTo: async (ctx: HTTPRequestContext) => (await resolvePack(d, ctx.path)).loaded.api.pay_to,
        price: async (ctx: HTTPRequestContext) => {
          const { loaded, pack } = await resolvePack(d, ctx.path);
          return { amount: pack.price_micros, asset: USDM_PREPROD_ASSET, extra: packExtra(d, loaded, pack) };
        },
        maxTimeoutSeconds: 600,
        extra: { confirmationPolicy: { l1Confirmations: d.config.l1Confirmations } },
      },
      description: "A pack of credits for a Hirakumi API. A credit is used only when a response keeps the published promise.",
      mimeType: "application/json",
      unpaidResponseBody: async (ctx: HTTPRequestContext) => {
        const { loaded, pack } = await resolvePack(d, ctx.path);
        return {
          contentType: "application/json",
          body: {
            error: "payment_required", ...packExtra(d, loaded, pack), price: pack.price_micros, asset: USDM_PREPROD_ASSET,
            message: `Pay once to get ${pack.calls} credits. A credit is used only when a response keeps the promise.`,
          },
        };
      },
      settlementFailedResponseBody: (_ctx, result) => ({
        contentType: "application/json",
        body: { error: "settlement_failed", reason: result.errorReason, message: "The payment did not settle. No credits were issued." },
      }),
    },
  };

  /** Runs before x402: unknown pack → 404, Down → 503, so no payment is ever requested for them. */
  const guard: RequestHandler = async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded || loaded.api.state !== "live") { res.status(404).json({ error: "api_not_found" }); return; }
      const pack = loaded.packs.find((p) => p.id === req.params.packId);
      if (!pack) { res.status(404).json({ error: "pack_not_found" }); return; }
      const snap = d.health.get(loaded.api.id);
      if (snap?.health === "down") { res.status(503).json(downBody(d.config, snap)); return; }
      if (!primaryRule(loaded)) { res.status(503).json({ error: "promise_not_published" }); return; }
      res.locals.loaded = loaded;
      res.locals.pack = pack;
      next();
    } catch (e) { next(e); }
  };

  /** Only reached after x402 verified the payment. Settlement happens after this returns (status < 400). */
  const handler: RequestHandler = async (req, res, next) => {
    try {
      const loaded = res.locals.loaded as LoadedApi;
      const pack = res.locals.pack as PackRow;
      const header = req.header("payment-signature") ?? req.header("x-payment");
      if (!header) { res.status(402).json({ error: "payment_required" }); return; }
      const payload = decodePaymentSignatureHeader(header);
      const token = newBearerToken();
      const ins = await insertPendingToken(d.sql, {
        id: newId("ct"), apiId: loaded.api.id, packId: pack.id, tokenHash: sha256Hex(token), remaining: pack.calls,
        paymentPayloadHash: paymentPayloadHash(payload.payload), txHash: txHashOf(payload.payload),
      });
      if (!ins.inserted) {
        res.status(409).json({
          error: "payment_already_used", tokenId: ins.id,
          message: "This payment already bought a credit token. Use the token you received the first time.",
        });
        return;
      }
      res.status(200).json({ token, credits: pack.calls, apiId: loaded.api.id, tokenId: ins.id });
    } catch (e) { next(e); }
  };

  const r = Router();
  r.post("/a/:apiId/packs/:packId", guard, paymentMiddleware(routes, server), handler);
  return r;
}
```

`apps/gateway/src/app.ts` (full file after this task):
```ts
import express, { type Express } from "express";
import { getRuleByHash } from "@hirakumi/db";
import { creditsRouter } from "./credits";
import type { AppDeps } from "./deps";
import { errorHandler } from "./http";
import { packRouter } from "./packs";

export function createApp(d: AppDeps): Express {
  const app = express();
  app.set("trust proxy", true); // Caddy terminates TLS; x402 resource URLs must say https
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  app.use(packRouter(d));
  app.use(creditsRouter(d));
  app.get("/r/:ruleHash", async (req, res, next) => {
    try {
      const rule = await getRuleByHash(d.sql, req.params.ruleHash);
      if (!rule) { res.status(404).json({ error: "rule_not_found" }); return; }
      res.set("cache-control", "public, max-age=31536000, immutable").json({
        ruleHash: rule.hash, version: rule.version, definition: rule.definition,
        plain_english: rule.plain_english, created_at: rule.created_at,
      });
    } catch (e) { next(e); }
  });
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/packs.test.ts test/credits.test.ts && pnpm --filter @hirakumi/gateway typecheck`
Expected: PASS (packs 5, credits 15), typecheck exits 0. If `offer()` returns 500, the console shows `Facilitator does not support exact on cardano:preprod`. That means the fake `getSupported` shape is off. Compare it to the live response with `curl -s https://x402.preprod.dev.ecosyseng.cf-deployments.org/supported`.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): x402 pack purchase with pending tokens activated on settlement" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: In-process monitor, `health_events` and a truthful `/availability`

**Files:**
- Create: `apps/gateway/src/monitor.ts`, `apps/gateway/src/mip003.ts` (availability only; Task 13 completes it)
- Modify: `apps/gateway/src/app.ts`
- Test: `apps/gateway/test/monitor.test.ts`

**Interfaces:**
- Consumes: `listMonitoredApiIds`, `loadProbeInputs`, `insertCall`, `touchHealthCheck`, `recordHealthTransition` (`@hirakumi/db`); `runOperation`; `HealthTracker`; `ApiRegistry`; `estimatedDowntimeSeconds`.
- Produces:
  - `export type MonitorDeps = { sql: Sql; registry: ApiRegistry; health: HealthTracker; config: Pick<GatewayConfig, "probeIntervalMs" | "upstreamTimeoutMs"> }`
  - `export class Monitor { constructor(d: MonitorDeps); start(): void; stop(): void; tick(): Promise<void>; probeApi(apiId: string): Promise<HealthTransition | null> }`
  - `export function mip003Router(d: AppDeps): Router` with `GET /a/:apiId/availability`. It returns 200 `{status:"available", type:"masumi-agent", message}` or 503 `{status:"unavailable", message, estimated_downtime_seconds}`. It reads memory only and never calls upstream.

Probe policy: each tick probes every API in state `registering` or `live`. For each enabled operation that has test inputs and a rule, it runs **one** saved input, rotating through the inputs on successive ticks, with header `x-hirakumi-probe: 1`. The API passes the probe only if every operation passes. Each probe is logged as `calls.kind = 'probe'`. On a state change the gateway updates `apis.health` and `health_checked_at` and inserts a `health_events` row with `reasons: [{op, reason, since}]`, in one statement. P3's coworker reads unnotified rows (`notified_at is null`) to post the Sokosumi comment.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/monitor.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Monitor } from "../src/monitor";
import { makeHarness, type Harness } from "./helpers";

let h: Harness; let m: Monitor;
beforeEach(async () => {
  h = await makeHarness();
  m = new Monitor({ sql: h.sql, registry: h.registry, health: h.health, config: h.config });
});
afterEach(async () => { m.stop(); await h.close(); });

const events = () => h.sql<{ from_health: string; to_health: string; reasons: Array<{ op: string; reason: string; since: string | null }> }[]>`
  select from_health, to_health, reasons from health_events order by id`;

describe("Monitor (demo thresholds: 2 fails → Down, 2 passes → Live)", () => {
  it("stays Live while probes pass and logs probe calls with the probe header", async () => {
    expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    expect(h.health.get(h.seeded.apiId)?.health).toBe("healthy");
    expect(h.stub.lastHeaders()?.["x-hirakumi-probe"]).toBe("1");
    const [c] = await h.sql<{ kind: string; verdict: string }[]>`select kind, verdict from calls`;
    expect(c).toEqual({ kind: "probe", verdict: "pass" });
    const [api] = await h.sql<{ health_checked_at: Date | null }[]>`select health_checked_at from apis`;
    expect(api.health_checked_at).not.toBeNull();
  });

  it("flips to Down on the 2nd failure: DB, health_events, /availability 503, proxy 503, pack 503", async () => {
    h.stub.setMode("empty");
    expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    const t = await m.probeApi(h.seeded.apiId);
    expect(t).toMatchObject({ from: "healthy", to: "down" });
    const [api] = await h.sql<{ health: string }[]>`select health from apis`;
    expect(api.health).toBe("down");
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ from_health: "healthy", to_health: "down" });
    expect(ev[0].reasons).toEqual(expect.arrayContaining([expect.objectContaining({ op: "getPrice", reason: "/price is missing" })]));
    expect(ev[0].reasons[0].since).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const av = await request(h.app).get(`/a/${h.seeded.apiId}/availability`);
    expect(av.status).toBe(503);
    expect(av.body).toMatchObject({ status: "unavailable", estimated_downtime_seconds: 20 });
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`)).status).toBe(503);
    expect((await request(h.app).post(`/a/${h.seeded.apiId}/packs/${h.seeded.packId}`)).status).toBe(503);
  });

  it("comes back Live after 2 passes and writes a second event", async () => {
    h.stub.setMode("empty");
    await m.probeApi(h.seeded.apiId);
    await m.probeApi(h.seeded.apiId);
    h.stub.setMode("ok");
    expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    expect(await m.probeApi(h.seeded.apiId)).toMatchObject({ from: "down", to: "healthy" });
    expect((await events()).map((e) => e.to_health)).toEqual(["down", "healthy"]);
    const av = await request(h.app).get(`/a/${h.seeded.apiId}/availability`);
    expect(av.status).toBe(200);
    expect(av.body).toMatchObject({ status: "available", type: "masumi-agent" });
  });

  it("tick() probes every live/registering API and skips others", async () => {
    await h.sql`update apis set state = 'priced'`;
    h.registry.invalidate(h.seeded.apiId);
    await m.tick();
    expect(h.stub.hits()).toBe(0);
    await h.sql`update apis set state = 'registering'`;
    h.registry.invalidate(h.seeded.apiId);
    await m.tick();
    expect(h.stub.hits()).toBe(1);
  });

  it("/availability answers 200 during registration (the registry checks it then) and 404 for unknown", async () => {
    await h.sql`update apis set state = 'registering'`;
    h.registry.invalidate(h.seeded.apiId);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/availability`)).status).toBe(200);
    expect((await request(h.app).get(`/a/api_nope/availability`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/monitor.test.ts`
Expected: FAIL, `Failed to resolve import "../src/monitor"`.

- [ ] **Step 3: Implement**

`apps/gateway/src/monitor.ts`:
```ts
import { insertCall, listMonitoredApiIds, loadProbeInputs, recordHealthTransition, touchHealthCheck, type Sql } from "@hirakumi/db";
import type { GatewayConfig } from "./config";
import type { HealthReason, HealthTracker, HealthTransition } from "./health";
import type { ApiRegistry } from "./registry";
import { runOperation } from "./upstream";

export type MonitorDeps = {
  sql: Sql; registry: ApiRegistry; health: HealthTracker;
  config: Pick<GatewayConfig, "probeIntervalMs" | "upstreamTimeoutMs">;
};

export class Monitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly rotation = new Map<string, number>();
  constructor(private readonly d: MonitorDeps) {}

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, this.d.config.probeIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return; // a slow upstream must not stack probes
    this.running = true;
    try {
      const ids = await listMonitoredApiIds(this.d.sql);
      await Promise.all(ids.map((id) => this.probeApi(id).catch((e) => console.error(`[monitor] ${id}:`, e))));
    } finally {
      this.running = false;
    }
  }

  async probeApi(apiId: string): Promise<HealthTransition | null> {
    const loaded = await this.d.registry.get(apiId);
    if (!loaded) return null;
    const inputs = await loadProbeInputs(this.d.sql, apiId);
    const byOp = new Map<string, unknown[]>();
    for (const row of inputs) byOp.set(row.op_id, [...(byOp.get(row.op_id) ?? []), row.input]);

    let probed = 0;
    const reasons: HealthReason[] = [];
    for (const [opId, list] of byOp) {
      const op = loaded.ops.get(opId);
      if (!op || !op.rule || !op.row.enabled) continue;
      const key = `${apiId}:${opId}`;
      const idx = (this.rotation.get(key) ?? 0) % list.length;
      this.rotation.set(key, idx + 1);
      const checked = op.validateInput(list[idx]);
      const input = checked.ok ? checked.value : (list[idx] as Record<string, unknown>);
      const outcome = await runOperation(loaded.api, op, input, { timeoutMs: this.d.config.upstreamTimeoutMs, probe: true });
      probed += 1;
      await insertCall(this.d.sql, {
        kind: "probe", apiId, opId, ruleId: op.ruleRow?.id ?? null, execution: outcome.execution,
        verdict: outcome.verdict, reasons: outcome.reasons, latencyMs: outcome.latencyMs,
      });
      if (!(outcome.execution === "upstream_ok" && outcome.verdict === "pass")) {
        reasons.push(...(outcome.reasons.length ? outcome.reasons : [outcome.execution]).map((reason) => ({ op: opId, reason })));
      }
    }
    if (probed === 0) return null; // nothing to probe: leave health as it is

    const t = this.d.health.record(apiId, reasons.length === 0, reasons);
    if (t) {
      const since = t.failingSince?.toISOString() ?? null;
      await recordHealthTransition(this.d.sql, apiId, t.from, t.to, t.reasons.map((r) => ({ ...r, since })));
      console.log(`[monitor] ${apiId} ${t.from} → ${t.to}${t.reasons[0] ? ` (${t.reasons[0].op}: ${t.reasons[0].reason})` : ""}`);
    } else {
      await touchHealthCheck(this.d.sql, apiId);
    }
    return t;
  }
}
```

`apps/gateway/src/mip003.ts`:
```ts
import { Router } from "express";
import { estimatedDowntimeSeconds } from "./config";
import type { AppDeps } from "./deps";

export function mip003Router(d: AppDeps): Router {
  const r = Router();

  r.get("/a/:apiId/availability", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded || !(loaded.api.state === "live" || loaded.api.state === "registering")) {
        res.status(404).json({ status: "unavailable", message: "Unknown API." });
        return;
      }
      const snap = d.health.get(loaded.api.id);
      if (snap?.health === "down") {
        const first = snap.lastReasons[0];
        res.status(503).json({
          status: "unavailable",
          message: `${loaded.api.name} is Down${first ? `: ${first.op} ${first.reason}` : ""}.`,
          estimated_downtime_seconds: estimatedDowntimeSeconds(d.config),
        });
        return;
      }
      res.json({ status: "available", type: "masumi-agent", message: `${loaded.api.name} is Live. Every answer is checked against a published promise.` });
    } catch (e) { next(e); }
  });

  return r;
}
```

In `apps/gateway/src/app.ts`, add the import and mount the router after `creditsRouter`:
```ts
import { mip003Router } from "./mip003";
// …
  app.use(packRouter(d));
  app.use(creditsRouter(d));
  app.use(mip003Router(d));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/monitor.test.ts && pnpm --filter @hirakumi/gateway typecheck`
Expected: PASS (5 tests), typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): in-process monitor with demo mode, health_events and truthful availability" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Internal routes (preview, challenge check, reload, health)

**Files:**
- Create: `apps/gateway/src/internal.ts`
- Modify: `apps/gateway/src/app.ts`
- Test: `apps/gateway/test/internal.test.ts`

**Interfaces:**
- Consumes: `getActiveHttpChallenge`, `consumeChallenge`, `insertCall`; `httpChallengePath`, `safeFetch`, `UpstreamBlockedError`, `UpstreamTimeoutError`; `runOperation`; `ApiRegistry#get(…,{fresh:true})`, `#invalidate`.
- Produces: `export function internalRouter(d: AppDeps): Router`. Every route needs `Authorization: Bearer ${INTERNAL_TOKEN}` (constant-time compare), or it answers 401.
  - `POST /internal/preview/:apiId/:opId` `{ input }` → 200 `UpstreamResult & { verdict?: Verdict }`, 400 `invalid_input` or `blocked`, 502 `upstream_error`, 504 `upstream_timeout`. Logs `calls.kind='preview'`. Works in any API state and on disabled operations, because onboarding uses it before go-live.
  - `POST /internal/challenge/:apiId/check` → `{ ok, triedUrl, detail }`. Fetches `origin + httpChallengePath(apiId)` (10s, 4 KB). Compares it, trimmed, to the open `challenges` row of kind `http` (unexpired, unconsumed). On a match it consumes the row (single use) with `proof = { url, status, checkedAt }`.
  - `POST /internal/apis/:apiId/reload` → `{ ok: true }`.
  - `GET /internal/apis/:apiId/health` → `{ health, checkedAt, lastReasons: string[] }`, where each reason is `"<op>: <reason>"`.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/internal.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { httpChallengePath } from "@hirakumi/core";
import { makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });
const auth = () => ({ authorization: `Bearer ${h.config.internalToken}` });

describe("internal auth", () => {
  it("401 without or with a wrong token", async () => {
    expect((await request(h.app).post(`/internal/apis/${h.seeded.apiId}/reload`)).status).toBe(401);
    expect((await request(h.app).post(`/internal/apis/${h.seeded.apiId}/reload`).set("authorization", "Bearer wrong")).status).toBe(401);
  });
});

describe("preview", () => {
  it("runs an unpaid test call, returns the result with a verdict and logs it", async () => {
    const r = await request(h.app).post(`/internal/preview/${h.seeded.apiId}/getPrice`).set(auth()).send({ input: { symbol: "ADA" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 200, contentType: "application/json", verdict: { pass: true, reasons: [] } });
    expect(JSON.parse(r.body.body).symbol).toBe("ADA");
    const [c] = await h.sql<{ kind: string }[]>`select kind from calls`;
    expect(c.kind).toBe("preview");
  });
  it("400 on bad input, 504 on timeout", async () => {
    expect((await request(h.app).post(`/internal/preview/${h.seeded.apiId}/getPrice`).set(auth()).send({ input: {} })).status).toBe(400);
    h.stub.setMode("slow");
    expect((await request(h.app).post(`/internal/preview/${h.seeded.apiId}/getPrice`).set(auth()).send({ input: { symbol: "ADA" } })).status).toBe(504);
  });
});

describe("challenge check", () => {
  const insertChallenge = (token: string) =>
    h.sql`insert into challenges (id, api_id, kind, token, expires_at) values (${`ch_${token}`}, ${h.seeded.apiId}, 'http', ${token}, now() + interval '30 minutes')`;
  const check = () => request(h.app).post(`/internal/challenge/${h.seeded.apiId}/check`).set(auth());

  it("passes once when the file matches, then the challenge is used up", async () => {
    await insertChallenge("tok-123");
    h.stub.setChallenge(httpChallengePath(h.seeded.apiId), "tok-123\n");
    const ok = await check();
    expect(ok.body).toEqual({ ok: true, triedUrl: `${h.stub.origin}${httpChallengePath(h.seeded.apiId)}`, detail: "Ownership file verified." });
    const [row] = await h.sql<{ consumed_at: Date | null; proof: { status: number } | null }[]>`select consumed_at, proof from challenges`;
    expect(row.consumed_at).not.toBeNull();
    expect(row.proof?.status).toBe(200);
    expect((await check()).body.ok).toBe(false);
  });
  it("explains a missing file and a wrong file with the exact URL tried", async () => {
    await insertChallenge("tok-456");
    const missing = await check();
    expect(missing.body).toMatchObject({ ok: false, triedUrl: `${h.stub.origin}${httpChallengePath(h.seeded.apiId)}` });
    expect(missing.body.detail).toMatch(/404/);
    h.stub.setChallenge(httpChallengePath(h.seeded.apiId), "something-else");
    expect((await check()).body.detail).toMatch(/does not match/);
  });
});

describe("reload and health", () => {
  it("reload drops cached prices", async () => {
    await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`);
    await h.sql`update packs set price_micros = 5000000`;
    expect((await request(h.app).post(`/internal/apis/${h.seeded.apiId}/reload`).set(auth())).body).toEqual({ ok: true });
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`);
    expect(r.body.packs[0].price).toBe("5000000");
  });
  it("health reports state, last check and reasons", async () => {
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "/price is missing" }]);
    const r = await request(h.app).get(`/internal/apis/${h.seeded.apiId}/health`).set(auth());
    expect(r.body).toMatchObject({ health: "healthy", lastReasons: ["getPrice: /price is missing"] });
    expect(r.body.checkedAt).toMatch(/^\d{4}-/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/internal.test.ts`
Expected: FAIL. The first test gets `expected 404 to be 401`.

- [ ] **Step 3: Implement**

`apps/gateway/src/internal.ts`:
```ts
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { httpChallengePath, safeFetch, UpstreamBlockedError, UpstreamTimeoutError } from "@hirakumi/core";
import { consumeChallenge, getActiveHttpChallenge, insertCall } from "@hirakumi/db";
import type { AppDeps } from "./deps";
import { runOperation } from "./upstream";

const digest = (s: string) => createHash("sha256").update(s).digest();

function requireInternalToken(token: string): RequestHandler {
  const expected = digest(`Bearer ${token}`);
  return (req, res, next) => {
    if (!timingSafeEqual(digest(req.header("authorization") ?? ""), expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function internalRouter(d: AppDeps): Router {
  const r = Router();
  r.use("/internal", requireInternalToken(d.config.internalToken));

  r.post("/internal/preview/:apiId/:opId", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId, { fresh: true });
      const op = loaded?.ops.get(req.params.opId);
      if (!loaded || !op) { res.status(404).json({ error: "operation_not_found" }); return; }
      const checked = op.validateInput((req.body as { input?: unknown } | undefined)?.input);
      if (!checked.ok) { res.status(400).json({ error: "invalid_input", reasons: checked.reasons }); return; }
      const outcome = await runOperation(loaded.api, op, checked.value, { timeoutMs: d.config.upstreamTimeoutMs });
      await insertCall(d.sql, {
        kind: "preview", apiId: loaded.api.id, opId: op.row.op_id, ruleId: op.ruleRow?.id ?? null,
        execution: outcome.execution, verdict: outcome.verdict, reasons: outcome.reasons, latencyMs: outcome.latencyMs,
      });
      if (outcome.execution === "blocked") { res.status(400).json({ error: "blocked", detail: outcome.reasons[0] }); return; }
      if (outcome.execution === "timeout") { res.status(504).json({ error: "upstream_timeout", detail: outcome.reasons[0] }); return; }
      if (!outcome.result) { res.status(502).json({ error: "upstream_error", detail: outcome.reasons[0] }); return; }
      res.json({ ...outcome.result, ...(op.rule ? { verdict: { pass: outcome.verdict === "pass", reasons: outcome.reasons } } : {}) });
    } catch (e) { next(e); }
  });

  r.post("/internal/challenge/:apiId/check", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId, { fresh: true });
      if (!loaded) { res.status(404).json({ error: "api_not_found" }); return; }
      const triedUrl = new URL(httpChallengePath(loaded.api.id), loaded.api.origin).toString();
      const challenge = await getActiveHttpChallenge(d.sql, loaded.api.id);
      if (!challenge) {
        res.json({ ok: false, triedUrl, detail: "There is no open ownership challenge. Download a new challenge file and try again." });
        return;
      }
      let detail: string;
      try {
        const got = await safeFetch(triedUrl, { method: "GET", headers: { accept: "text/plain" } }, { timeoutMs: 10_000, maxBytes: 4096 });
        if (got.status !== 200) {
          detail = `Your server answered ${got.status} instead of 200. Upload the file to exactly this address.`;
        } else if (got.body.trim() !== challenge.token.trim()) {
          detail = "The file was found, but its contents do not match the challenge. Upload the file you downloaded, unchanged.";
        } else {
          await consumeChallenge(d.sql, challenge.id, { url: triedUrl, status: got.status, checkedAt: new Date().toISOString() });
          res.json({ ok: true, triedUrl, detail: "Ownership file verified." });
          return;
        }
      } catch (e) {
        if (e instanceof UpstreamBlockedError) detail = `This address is not allowed: ${e.message}`;
        else if (e instanceof UpstreamTimeoutError) detail = "Your server did not answer within 10 seconds.";
        else detail = `Could not reach your server: ${(e as Error).message}`;
      }
      res.json({ ok: false, triedUrl, detail });
    } catch (e) { next(e); }
  });

  r.post("/internal/apis/:apiId/reload", (req, res) => {
    d.registry.invalidate(req.params.apiId);
    res.json({ ok: true });
  });

  r.get("/internal/apis/:apiId/health", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded) { res.status(404).json({ error: "api_not_found" }); return; }
      const snap = d.health.get(loaded.api.id);
      res.json({
        health: snap?.health ?? loaded.api.health,
        checkedAt: (snap?.checkedAt ?? loaded.api.health_checked_at)?.toISOString() ?? null,
        lastReasons: (snap?.lastReasons ?? []).map((x) => `${x.op}: ${x.reason}`),
      });
    } catch (e) { next(e); }
  });

  return r;
}
```

In `apps/gateway/src/app.ts`, mount it **first**, right after `/healthz`:
```ts
import { internalRouter } from "./internal";
// …
  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  app.use(internalRouter(d));
  app.use(packRouter(d));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/gateway exec vitest run && pnpm --filter @hirakumi/gateway typecheck`
Expected: PASS (all gateway tests so far), typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): internal preview, ownership challenge check, reload and health routes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Process entry, demo scripts, and the **hour-10 preprod checkpoint**

**Files:**
- Create: `apps/gateway/src/main.ts`, `apps/gateway/scripts/stub-seller.ts`, `apps/gateway/scripts/seed-demo.ts`, `apps/gateway/scripts/smoke-buyer.ts`
- Test: the checkpoint run below. It is a manual end-to-end test on preprod; every unit it wires together is already covered.

**Interfaces:**
- Consumes:
  - From `@x402/core/server`: `HTTPFacilitatorClient({ url })`.
  - `loadConfig`, `createDb`, `migrate`, `HealthTracker`, `ApiRegistry`, `createApp`, `Monitor`.
  - `inferRule`, `ruleHash`, `safeFetch`, `newId`.
  - For the smoke buyer, from `@x402/fetch`: `x402Client`, `wrapFetchWithPayment`, `x402HTTPClient`. From `@x402/cardano`: `toClientCardanoSigner`, `USDM_PREPROD_ASSET`. From `@x402/cardano/exact/client`: `ExactCardanoScheme`.
- Produces:
  - A running gateway on `GATEWAY_PORT`.
  - `seed-demo.ts <origin> <path> [queryJSON] [opId]`: prints `apiId`, `opId`, `packId` and the curl lines.
  - `smoke-buyer.ts <operationUrl>`: prints the 402 → pay → 200 timeline and `TOKEN=…`.
  - `stub-seller.ts`: `GET /price?symbol=`, and `POST /mode?set=ok|empty|stale`.

- [ ] **Step 1: Write the entry point**

`apps/gateway/src/main.ts`:
```ts
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createDb, migrate } from "@hirakumi/db";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { HealthTracker } from "./health";
import { Monitor } from "./monitor";
import { ApiRegistry } from "./registry";

const config = loadConfig();
const sql = createDb(config.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log(`[gateway] migrations applied: ${applied.join(", ")}`);

const health = new HealthTracker(config.thresholds);
const registry = new ApiRegistry(sql, health);
const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
const app = createApp({ sql, config, registry, health, facilitator, masumi: null });
const monitor = new Monitor({ sql, registry, health, config });
monitor.start();

const server = app.listen(config.port, () => {
  console.log(`[gateway] listening on :${config.port} public=${config.publicBaseUrl} demo=${config.demoMode} ` +
    `probe=${config.probeIntervalMs / 1000}s facilitator=${config.facilitatorUrl}`);
});

const shutdown = async () => {
  monitor.stop();
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
```

- [ ] **Step 2: Write the local stub seller (a fallback until P5's `sellers/price-api` is deployed)**

`apps/gateway/scripts/stub-seller.ts`:
```ts
import http from "node:http";

type Mode = "ok" | "empty" | "stale";
let mode: Mode = "ok";
const port = Number(process.env.STUB_PORT ?? 4030);

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && url.pathname === "/mode") {
    const m = url.searchParams.get("set");
    if (m === "ok" || m === "empty" || m === "stale") mode = m;
    res.end(`mode=${mode}\n`);
    return;
  }
  if (url.pathname === "/price") {
    const updatedAt = mode === "stale" ? new Date(Date.now() - 3_600_000) : new Date();
    const body = mode === "empty" ? {} : { symbol: url.searchParams.get("symbol") ?? "ADA", price: 0.42, updatedAt: updatedAt.toISOString() };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, "127.0.0.1", () => {
  console.log(`stub seller on http://127.0.0.1:${port}  (curl -X POST 'http://127.0.0.1:${port}/mode?set=empty')`);
});
```

- [ ] **Step 3: Write the manual-onboarding seed (samples → `inferRule` → rows)**

`apps/gateway/scripts/seed-demo.ts`:
```ts
import { inferRule, newId, ruleHash, safeFetch } from "@hirakumi/core";
import { createDb, migrate } from "@hirakumi/db";

const [origin, path, queryJson = "{}", opId = "getPrice"] = process.argv.slice(2);
if (!origin || !path) {
  console.error("usage: tsx scripts/seed-demo.ts <origin> <path> [queryJSON] [opId]");
  process.exit(1);
}
const payTo = process.env.SELLER_DEMO_ADDRESS?.trim() ?? "";
const dbUrl = process.env.DATABASE_URL?.trim() ?? "";
if (!payTo.startsWith("addr_test1") || !dbUrl) {
  console.error("Set SELLER_DEMO_ADDRESS (addr_test1…) and DATABASE_URL");
  process.exit(1);
}
const query = JSON.parse(queryJson) as Record<string, string>;
const url = new URL(path, origin);
for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

const samples: unknown[] = [];
for (let i = 0; i < 5; i++) {
  const r = await safeFetch(url.toString(), { method: "GET", headers: { accept: "application/json" } });
  if (r.status !== 200) {
    console.error(`sample ${i + 1}: HTTP ${r.status} ${r.body.slice(0, 200)}`);
    process.exit(1);
  }
  samples.push(JSON.parse(r.body));
}
const definition = inferRule(samples);
const hash = ruleHash(definition);
const inputSchema = {
  type: "object",
  properties: Object.fromEntries(Object.keys(query).map((k) => [k, { type: "string" }])),
  required: Object.keys(query),
  additionalProperties: false,
};

const sql = createDb(dbUrl, { max: 1 });
await migrate(sql);
const [existing] = await sql<{ api_id: string }[]>`select o.api_id from rules r join operations o on o.id = r.operation_id where r.hash = ${hash}`;
if (existing) {
  console.log(`Already seeded with this promise: api ${existing.api_id}`);
  await sql.end();
  process.exit(0);
}
const [seller] = await sql<{ id: string }[]>`
  insert into sellers (id, cardano_addr) values (${newId("sel")}, ${payTo})
  on conflict (cardano_addr) do update set cardano_addr = excluded.cardano_addr returning id`;
const apiId = newId("api"), operationId = newId("op"), packId = newId("pk");
await sql`
  insert into apis (id, seller_id, name, origin, openapi_url, state, health, escrow_op_id)
  values (${apiId}, ${seller.id}, 'Demo Price API', ${url.origin}, ${`${url.origin}/openapi.json`}, 'live', 'healthy', ${operationId})`;
await sql`
  insert into operations (id, api_id, op_id, method, path, input_schema, enabled, side_effects_confirmed_none, description)
  values (${operationId}, ${apiId}, ${opId}, 'GET', ${url.pathname}, ${sql.json(inputSchema)}, true, true, 'Seeded by hand for the hour-10 checkpoint')`;
await sql`
  insert into rules (id, operation_id, version, definition, hash, plain_english)
  values (${newId("rule")}, ${operationId}, 1, ${sql.json(definition as never)}, ${hash}, 'Inferred from 5 live samples.')`;
await sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values (${packId}, ${apiId}, 100, 2000000, 1000000)`;
await sql`insert into test_inputs (id, operation_id, input) values (${newId("ti")}, ${operationId}, ${sql.json(query)})`;
await sql.end();

const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? "http://localhost:4021";
const qs = new URLSearchParams(query).toString();
console.log(JSON.stringify({ apiId, opId, packId, ruleHash: hash }, null, 2));
console.log(`\nOperation: ${base}/a/${apiId}/x/${opId}${qs ? `?${qs}` : ""}`);
console.log(`Pack:      ${base}/a/${apiId}/packs/${packId}`);
console.log(`Promise:   ${base}/r/${hash}`);
```

- [ ] **Step 4: Write the preprod smoke buyer**

`apps/gateway/scripts/smoke-buyer.ts`:
```ts
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { toClientCardanoSigner, USDM_PREPROD_ASSET } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";

const [opUrl] = process.argv.slice(2);
const mnemonic = process.env.BUYER_MNEMONIC?.trim() ?? "";
const projectId = process.env.BLOCKFROST_PROJECT_ID?.trim() ?? "";
if (!opUrl || !mnemonic || !projectId) {
  console.error("usage: tsx scripts/smoke-buyer.ts <operationUrl>   (needs BUYER_MNEMONIC, BLOCKFROST_PROJECT_ID)");
  process.exit(1);
}

const first = await fetch(opUrl);
const offer = (await first.json()) as { packs?: Array<{ buyUrl: string; price: string; calls: number }> };
console.log(`1) no token → ${first.status}`, JSON.stringify(offer));
if (first.status !== 402 || !offer.packs?.length) process.exit(1);
const pack = offer.packs[0];

const client = new x402Client().setSpendControls({
  allowedAssets: [{ network: "cardano:*", asset: USDM_PREPROD_ASSET, maxAmountPerPayment: pack.price }],
});
const signer = toClientCardanoSigner({
  mnemonic, network: "cardano:preprod",
  provider: { blockfrost: { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId } },
});
client.register("cardano:*", new ExactCardanoScheme(signer));

const t0 = Date.now();
const bought = await wrapFetchWithPayment(fetch, client)(pack.buyUrl, { method: "POST" });
const body = (await bought.json()) as { token?: string; credits?: number };
console.log(`2) buy pack (${pack.calls} calls, ${Number(pack.price) / 1e6} tUSDM) → ${bought.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
try {
  const receipt = new x402HTTPClient(client).getPaymentSettleResponse((n) => bought.headers.get(n));
  console.log(`   tx https://preprod.cardanoscan.io/transaction/${receipt.transaction}`);
} catch {
  console.log("   (no PAYMENT-RESPONSE receipt)");
}
if (!body.token) process.exit(1);

for (let i = 0; i < 3; i++) {
  const t1 = performance.now();
  const call = await fetch(opUrl, { headers: { authorization: `Bearer ${body.token}` } });
  console.log(`3.${i + 1}) call → ${call.status} credits=${call.headers.get("x-credits-remaining")} ${(performance.now() - t1).toFixed(0)}ms ${(await call.text()).slice(0, 120)}`);
}
console.log(`TOKEN=${body.token}`);
```

- [ ] **Step 5: Typecheck and run all tests**

Run: `pnpm --filter @hirakumi/gateway typecheck && pnpm test`
Expected: typecheck exits 0; all db, core and gateway tests PASS.

- [ ] **Step 6: Hour-10 checkpoint on preprod (manual)**

```bash
cd /Users/frederick/Documents/Projects/token2049
cp -n .env.example .env
# edit .env: PUBLIC_BASE_URL=http://localhost:4021  INTERNAL_TOKEN=<32+ random chars>  DEMO_MODE=1
#            ALLOW_INSECURE_UPSTREAM=1 (only while using the local stub)  BLOCKFROST_PROJECT_ID=preprod…
#            SELLER_DEMO_ADDRESS=<seller addr_test1…>  BUYER_MNEMONIC=<funded buyer from Task 0>
set -a; . ./.env; set +a
pnpm db:up && pnpm db:migrate

# Terminal A: the seller. Use P5's deployed price-api if it exists; otherwise the stub:
pnpm --filter @hirakumi/gateway exec tsx scripts/stub-seller.ts
# Terminal B: seed (origin = https://<price-api>.vercel.app or http://127.0.0.1:4030)
pnpm --filter @hirakumi/gateway exec tsx --env-file=../../.env scripts/seed-demo.ts http://127.0.0.1:4030 /price '{"symbol":"ADA"}'
# Terminal C: the gateway
pnpm --filter @hirakumi/gateway dev
# Terminal B: buy and call (uses the Operation URL printed by seed-demo)
pnpm --filter @hirakumi/gateway exec tsx --env-file=../../.env scripts/smoke-buyer.ts "http://localhost:4021/a/<apiId>/x/getPrice?symbol=ADA"
```
Expected in B:
- `1) no token → 402` with a pack at price `2000000`.
- `2) buy pack … → 200 in ~20–40s` and a Cardanoscan link (check it shows 2 tUSDM to `SELLER_DEMO_ADDRESS`).
- `3.1) call → 200 credits=99`, `3.2) … credits=98`, `3.3) … credits=97`, each well under 100 ms of overhead with the local stub.
- In C: `[packs] settled tx=… token activated=true`.

Pass/fail (422) with unchanged credits:
```bash
curl -X POST 'http://127.0.0.1:4030/mode?set=empty'      # or P5's break switch
curl -s -i -H "authorization: Bearer $TOKEN" "http://localhost:4021/a/<apiId>/x/getPrice?symbol=ADA" | sed -n '1p;/x-credits-remaining/p;$p'
```
Expected: `HTTP/1.1 422`, `x-credits-remaining: 97` (unchanged), and a body with `"promise_not_met"` and `"/price is missing"`.

Down (503) within 20s, before any payment:
```bash
sleep 21
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:4021/a/<apiId>/x/getPrice?symbol=ADA"         # expect 503
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:4021/a/<apiId>/availability"                 # expect 503
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://localhost:4021/a/<apiId>/packs/<packId>"        # expect 503
psql "$DATABASE_URL" -c "select from_health, to_health, reasons, at from health_events order by id desc limit 1"
curl -X POST 'http://127.0.0.1:4030/mode?set=ok'; sleep 21
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:4021/a/<apiId>/availability"                 # expect 200
```
Post in team chat: "Hour-10 gate: packs → credits → 200/422/503 on preprod ✅ tx=<hash>". If any line fails, the whole team helps P1 (contract checkpoint rule).

- [ ] **Step 7: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): entry point, manual-onboarding seed, stub seller and preprod smoke buyer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: MIP-003 `start_job` / `status` / `input_schema` and the escrow `JobRunner`

**Files:**
- Modify: `apps/gateway/src/mip003.ts` (full replacement)
- Create: `apps/gateway/src/jobs.ts`
- Test: `apps/gateway/test/mip003.test.ts`

**Interfaces:**
- Consumes: `MasumiPort` (contract `createPaymentRequest` / `getPaymentState` / `submitResult`, bound to config); `insertJob`, `getJob`, `listJobsAwaitingPayment`, `listUnsubmittedPasses`, `claimJob`, `storeJobOutput`, `markJobCompleted`, `failJob`, `expireJob`, `resetInterruptedJobs`, `insertCall`, `JobRow`; `inputHash`, `outputHash`, `newId`; `escrowOperation`, `normalizeMip003Input`, `runOperation`.
- Produces:
  - `export type Mip003Field = { id: string; type: "string" | "number" | "boolean" | "option"; name: string; data?: { description?: string; options?: string[] } }`
  - `export function toMip003Fields(schema: Record<string, unknown>): Mip003Field[]`
  - `export const PURCHASER_ID = /^(?:[0-9a-f]{2}){7,32}$/` (14–64 even-length lowercase hex. It becomes the buyer nonce bytes in the escrow datum, per `x402-cardano-demo/masumi/src/agent.ts`.)
  - `mip003Router(d: AppDeps): Router`. It adds:
    - `POST /a/:apiId/start_job` → 200 `{ id, job_id, status:"awaiting_payment", blockchainIdentifier, payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime, agentIdentifier, sellerVKey, identifierFromPurchaser, input_hash }` (times in epoch ms), or 400 `INVALID_INPUT`, 404, 503.
    - `GET /a/:apiId/status?job_id=` → MIP-003 status object, or 404 `JOB_NOT_FOUND`.
    - `GET /a/:apiId/input_schema` → `{ input_data: Mip003Field[] }`.
  - `export class JobRunner { constructor(d: { sql: Sql; registry: ApiRegistry; masumi: MasumiPort; config: Pick<GatewayConfig, "upstreamTimeoutMs" | "demoMode"> }); start(): void; stop(): void; tick(): Promise<void> }`

Job lifecycle:
- `awaiting_payment` → (`FundsLocked`) → `running` → upstream → rule.
- **pass**: store the output, then `submitResult(outputHash)`, then `completed`. If the submit throws, the job stays `running` with its output saved, and the next tick retries until `submit_result_time`.
- **fail**: `failed` with reasons. **Never submit.** Masumi refunds automatically after `submitResultTime`.
- `payByTime` passed and still not `FundsLocked` → `expired`. Upstream is never called.

The input hash covers `input_data` **exactly as the buyer sent it** (MIP-004: buyers recompute it). The normalised and coerced object is what goes upstream.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/mip003.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { inputHash, outputHash } from "@hirakumi/core";
import { JobRunner } from "../src/jobs";
import { toMip003Fields } from "../src/mip003";
import { makeHarness, type Harness } from "./helpers";

let h: Harness; let runner: JobRunner;
const PID = "aabbccddeeff00112233";
beforeEach(async () => {
  h = await makeHarness();
  runner = new JobRunner({ sql: h.sql, registry: h.registry, masumi: h.masumi, config: h.config });
});
afterEach(async () => { runner.stop(); await h.close(); });

const start = (body: unknown) => request(h.app).post(`/a/${h.seeded.apiId}/start_job`).send(body as object);
const status = (jobId: string) => request(h.app).get(`/a/${h.seeded.apiId}/status`).query({ job_id: jobId });

describe("start_job", () => {
  it("creates a payment request with the MIP-004 input hash of input_data as sent", async () => {
    const input_data = [{ key: "symbol", value: "ADA" }];
    const r = await start({ input_data, identifier_from_purchaser: PID });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "awaiting_payment", identifierFromPurchaser: PID, agentIdentifier: "agent_test_1", sellerVKey: "vkey_test" });
    expect(r.body.job_id).toBe(r.body.id);
    expect(r.body.input_hash).toBe(inputHash(PID, input_data));
    expect(h.masumi.created).toEqual([{ agentIdentifier: "agent_test_1", inputHash: inputHash(PID, input_data), identifierFromPurchaser: PID }]);
    expect(typeof r.body.payByTime).toBe("number");
    expect((await status(r.body.job_id)).body).toMatchObject({ status: "awaiting_payment" });
  });
  it("400 for a bad purchaser id or input; no payment request is created", async () => {
    expect((await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: "not-hex" })).status).toBe(400);
    const bad = await start({ input_data: { nope: 1 }, identifier_from_purchaser: PID });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("INVALID_INPUT");
    expect(h.masumi.created).toHaveLength(0);
  });
  it("503 when the API is Down; no payment request is created", async () => {
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    expect((await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: PID })).status).toBe(503);
    expect(h.masumi.created).toHaveLength(0);
  });
  it("503 when the API has no agent identifier yet", async () => {
    await h.sql`update apis set agent_identifier = null`;
    h.registry.invalidate(h.seeded.apiId);
    expect((await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: PID })).status).toBe(503);
  });
});

describe("JobRunner", () => {
  async function newJob(): Promise<string> {
    return (await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: PID })).body.job_id as string;
  }

  it("waiting for payment never calls upstream", async () => {
    const id = await newJob();
    await runner.tick();
    expect(h.stub.hits()).toBe(0);
    expect((await status(id)).body.status).toBe("awaiting_payment");
  });

  it("pass: runs once funds are locked and submits the output hash", async () => {
    const id = await newJob();
    h.masumi.state = "FundsLocked";
    await runner.tick();
    expect(h.stub.hits()).toBe(1);
    const s = await status(id);
    expect(s.body).toMatchObject({ job_id: id, status: "completed", input_hash: inputHash(PID, { symbol: "ADA" }) });
    expect(s.body.output_hash).toBe(outputHash(PID, s.body.output));
    expect(h.masumi.submitted).toEqual([{ blockchainIdentifier: expect.stringMatching(/^bc_/), resultHash: s.body.output_hash }]);
    const [c] = await h.sql<{ kind: string; verdict: string; job_id: string }[]>`select kind, verdict, job_id from calls`;
    expect(c).toEqual({ kind: "escrow", verdict: "pass", job_id: id });
  });

  it("fail submits nothing and reports what failed", async () => {
    const id = await newJob();
    h.masumi.state = "FundsLocked";
    h.stub.setMode("empty");
    await runner.tick();
    expect(h.masumi.submitted).toHaveLength(0);
    const s = await status(id);
    expect(s.body).toMatchObject({ status: "failed", error: "promise_not_met" });
    expect(s.body.reasons).toContain("/price is missing");
    expect(s.body.message).toMatch(/refund/i);
  });

  it("expired: pay-by passed without locked funds → upstream never called", async () => {
    const id = await newJob();
    await h.sql`update jobs set pay_by_time = now() - interval '1 minute' where id = ${id}`;
    await runner.tick();
    expect(h.stub.hits()).toBe(0);
    expect((await status(id)).body).toMatchObject({ status: "failed", error: "payment_not_received" });
  });

  it("a failed submit is retried on the next tick", async () => {
    const id = await newJob();
    h.masumi.state = "FundsLocked";
    const original = h.masumi.submitResult.bind(h.masumi);
    let calls = 0;
    h.masumi.submitResult = async (b, r) => { calls += 1; if (calls === 1) throw new Error("node busy"); return original(b, r); };
    await runner.tick();
    expect((await status(id)).body.status).toBe("running");
    await runner.tick();
    expect((await status(id)).body.status).toBe("completed");
    expect(h.stub.hits()).toBe(1);
  });
});

describe("status and input_schema", () => {
  it("404 for an unknown job", async () => {
    const r = await status("job_nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("JOB_NOT_FOUND");
  });
  it("input_schema lists the escrow operation's fields in MIP-003 form", async () => {
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/input_schema`);
    expect(r.body).toEqual({ input_data: [{ id: "symbol", type: "string", name: "symbol", data: { description: "Ticker, e.g. ADA" } }] });
  });
  it("toMip003Fields maps enums to options and numbers", () => {
    expect(toMip003Fields({ type: "object", properties: { n: { type: "integer", title: "Count" }, c: { enum: ["a", "b"] }, f: { type: "boolean" } } }))
      .toEqual([
        { id: "n", type: "number", name: "Count", data: {} },
        { id: "c", type: "option", name: "c", data: { options: ["a", "b"] } },
        { id: "f", type: "boolean", name: "f", data: {} },
      ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/mip003.test.ts`
Expected: FAIL, `Failed to resolve import "../src/jobs"` and `toMip003Fields is not exported`.

- [ ] **Step 3: Implement**

`apps/gateway/src/mip003.ts` (full file):
```ts
import { Router } from "express";
import { inputHash, newId } from "@hirakumi/core";
import { getJob, insertJob, type JobRow } from "@hirakumi/db";
import { estimatedDowntimeSeconds } from "./config";
import type { AppDeps } from "./deps";
import { downBody } from "./http";
import { escrowOperation } from "./registry";
import { normalizeMip003Input } from "./upstream";

export type Mip003Field = {
  id: string; type: "string" | "number" | "boolean" | "option"; name: string;
  data?: { description?: string; options?: string[] };
};

/** JSON Schema object properties → Sokosumi/MIP-003 typed input fields. */
export function toMip003Fields(schema: Record<string, unknown>): Mip003Field[] {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(props).map(([id, p]) => {
    const options = Array.isArray(p.enum) ? p.enum.map(String) : null;
    const type: Mip003Field["type"] = options
      ? "option"
      : p.type === "number" || p.type === "integer" ? "number"
      : p.type === "boolean" ? "boolean"
      : "string";
    const data: NonNullable<Mip003Field["data"]> = {};
    if (typeof p.description === "string") data.description = p.description;
    if (options) data.options = options;
    return { id, type, name: typeof p.title === "string" ? p.title : id, data };
  });
}

export const PURCHASER_ID = /^(?:[0-9a-f]{2}){7,32}$/;

function statusBody(job: JobRow) {
  const base = { job_id: job.id, id: job.id };
  switch (job.status) {
    case "awaiting_payment":
      return { ...base, status: "awaiting_payment", blockchainIdentifier: job.blockchain_identifier, input_hash: job.input_hash };
    case "running":
      return { ...base, status: "running" };
    case "completed":
      return { ...base, status: "completed", output: job.output, result: job.output, input_hash: job.input_hash, output_hash: job.output_hash };
    case "failed":
      return {
        ...base, status: "failed", error: "promise_not_met", reasons: job.failure_reasons ?? [],
        message: "The answer did not keep the published promise. No result was submitted, so your payment is refunded automatically after the submit-result deadline.",
      };
    case "expired":
      return { ...base, status: "failed", error: "payment_not_received", message: "No payment arrived before the pay-by time. Nothing was charged." };
  }
}

export function mip003Router(d: AppDeps): Router {
  const r = Router();

  r.get("/a/:apiId/availability", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded || !(loaded.api.state === "live" || loaded.api.state === "registering")) {
        res.status(404).json({ status: "unavailable", message: "Unknown API." });
        return;
      }
      const snap = d.health.get(loaded.api.id);
      if (snap?.health === "down") {
        const first = snap.lastReasons[0];
        res.status(503).json({
          status: "unavailable",
          message: `${loaded.api.name} is Down${first ? `: ${first.op} ${first.reason}` : ""}.`,
          estimated_downtime_seconds: estimatedDowntimeSeconds(d.config),
        });
        return;
      }
      res.json({ status: "available", type: "masumi-agent", message: `${loaded.api.name} is Live. Every answer is checked against a published promise.` });
    } catch (e) { next(e); }
  });

  r.get("/a/:apiId/input_schema", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      const op = loaded ? escrowOperation(loaded) : undefined;
      if (!loaded || !op) { res.status(404).json({ error: "escrow_operation_not_set" }); return; }
      res.json({ input_data: toMip003Fields(op.row.input_schema) });
    } catch (e) { next(e); }
  });

  r.post("/a/:apiId/start_job", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded || loaded.api.state !== "live") { res.status(404).json({ error: "api_not_found" }); return; }
      const op = escrowOperation(loaded);
      if (!op?.rule) { res.status(503).json({ error: "escrow_not_configured", message: "This API has no escrow operation with a published promise." }); return; }
      const { input_data, identifier_from_purchaser: pid } = (req.body ?? {}) as { input_data?: unknown; identifier_from_purchaser?: unknown };
      if (typeof pid !== "string" || !PURCHASER_ID.test(pid)) {
        res.status(400).json({ error: "INVALID_INPUT", message: "identifier_from_purchaser must be 14-64 lowercase hex characters (even length)." });
        return;
      }
      const normalized = normalizeMip003Input(input_data);
      const checked = normalized ? op.validateInput(normalized) : { ok: false as const, reasons: ["input_data must be an object or a list of {key, value}"] };
      if (!checked.ok) { res.status(400).json({ error: "INVALID_INPUT", reasons: checked.reasons }); return; }
      const snap = d.health.get(loaded.api.id);
      if (snap?.health === "down") { res.status(503).json(downBody(d.config, snap)); return; }
      if (!d.masumi) { res.status(503).json({ error: "escrow_unavailable", message: "Escrow payments are not configured on this gateway." }); return; }
      if (!loaded.api.agent_identifier) { res.status(503).json({ error: "agent_not_registered", message: "This API is not registered on Masumi yet." }); return; }

      const hash = inputHash(pid, input_data);
      const now = Date.now();
      const pr = await d.masumi.createPaymentRequest({
        agentIdentifier: loaded.api.agent_identifier, inputHash: hash, identifierFromPurchaser: pid,
        payByTime: new Date(now + d.config.escrow.payByMs), submitResultTime: new Date(now + d.config.escrow.submitResultMs),
      });
      const jobId = newId("job");
      await insertJob(d.sql, {
        id: jobId, apiId: loaded.api.id, identifierFromPurchaser: pid, input: input_data, inputHash: hash,
        blockchainIdentifier: pr.blockchainIdentifier, payByTime: pr.payByTime, submitResultTime: pr.submitResultTime,
      });
      res.json({
        id: jobId, job_id: jobId, status: "awaiting_payment",
        blockchainIdentifier: pr.blockchainIdentifier,
        payByTime: pr.payByTime.getTime(), submitResultTime: pr.submitResultTime.getTime(),
        unlockTime: pr.unlockTime.getTime(), externalDisputeUnlockTime: pr.externalDisputeUnlockTime.getTime(),
        agentIdentifier: loaded.api.agent_identifier, sellerVKey: pr.sellerVKey,
        identifierFromPurchaser: pid, input_hash: hash,
      });
    } catch (e) { next(e); }
  });

  r.get("/a/:apiId/status", async (req, res, next) => {
    try {
      const jobId = typeof req.query.job_id === "string" ? req.query.job_id : "";
      const job = jobId ? await getJob(d.sql, req.params.apiId, jobId) : null;
      if (!job) { res.status(404).json({ error: "JOB_NOT_FOUND" }); return; }
      res.json(statusBody(job));
    } catch (e) { next(e); }
  });

  return r;
}
```

`apps/gateway/src/jobs.ts`:
```ts
import { outputHash } from "@hirakumi/core";
import {
  claimJob, expireJob, failJob, insertCall, listJobsAwaitingPayment, listUnsubmittedPasses, markJobCompleted,
  resetInterruptedJobs, storeJobOutput, type JobRow, type Sql,
} from "@hirakumi/db";
import type { GatewayConfig } from "./config";
import type { MasumiPort } from "./masumi-port";
import { escrowOperation, type ApiRegistry } from "./registry";
import { normalizeMip003Input, runOperation } from "./upstream";

export type JobRunnerDeps = {
  sql: Sql; registry: ApiRegistry; masumi: MasumiPort;
  config: Pick<GatewayConfig, "upstreamTimeoutMs" | "demoMode">;
};

export class JobRunner {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly d: JobRunnerDeps) {}

  start(): void {
    void resetInterruptedJobs(this.d.sql).then((n) => { if (n) console.log(`[jobs] re-queued ${n} interrupted job(s)`); });
    this.timer = setInterval(() => { void this.tick(); }, this.d.config.demoMode ? 5_000 : 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Retries first (snapshot taken before this tick's new work), so a submit that fails now is retried next tick.
      for (const job of await listUnsubmittedPasses(this.d.sql)) {
        await this.submit(job).catch((e) => console.error(`[jobs] submit ${job.id}:`, (e as Error).message));
      }
      for (const job of await listJobsAwaitingPayment(this.d.sql)) {
        await this.advance(job).catch((e) => console.error(`[jobs] ${job.id}:`, e));
      }
    } finally {
      this.running = false;
    }
  }

  private async advance(job: JobRow): Promise<void> {
    if (!job.blockchain_identifier) return;
    const state = await this.d.masumi.getPaymentState(job.blockchain_identifier);
    if (state !== "FundsLocked") {
      if (job.pay_by_time && Date.now() > job.pay_by_time.getTime()) await expireJob(this.d.sql, job.id);
      return;
    }
    if (!(await claimJob(this.d.sql, job.id))) return;

    const loaded = await this.d.registry.get(job.api_id);
    const op = loaded ? escrowOperation(loaded) : undefined;
    const normalized = normalizeMip003Input(job.input);
    if (!loaded || !op?.rule || !normalized) {
      await failJob(this.d.sql, job.id, ["the escrow operation is no longer available"]);
      return;
    }
    const checked = op.validateInput(normalized);
    const outcome = await runOperation(loaded.api, op, checked.ok ? checked.value : normalized, { timeoutMs: this.d.config.upstreamTimeoutMs });
    const outHash = outcome.result ? outputHash(job.identifier_from_purchaser, outcome.result.body) : null;
    await insertCall(this.d.sql, {
      kind: "escrow", jobId: job.id, blockchainId: job.blockchain_identifier, apiId: loaded.api.id, opId: op.row.op_id,
      ruleId: op.ruleRow?.id ?? null, execution: outcome.execution, verdict: outcome.verdict, reasons: outcome.reasons,
      latencyMs: outcome.latencyMs, inputHash: job.input_hash, outputHash: outHash,
    });
    if (!(outcome.execution === "upstream_ok" && outcome.verdict === "pass" && outcome.result && outHash)) {
      await failJob(this.d.sql, job.id, outcome.reasons.length ? outcome.reasons : [`upstream ${outcome.execution}`]);
      return; // no result submitted → Masumi refunds after submitResultTime
    }
    await storeJobOutput(this.d.sql, job.id, outcome.result.body, outHash);
    await this.submit({ ...job, status: "running", output: outcome.result.body, output_hash: outHash });
  }

  private async submit(job: JobRow): Promise<void> {
    if (!job.blockchain_identifier || !job.output_hash) return;
    if (job.submit_result_time && Date.now() > job.submit_result_time.getTime()) {
      await failJob(this.d.sql, job.id, ["the result was ready after the submit-result deadline; the buyer is refunded automatically"]);
      return;
    }
    await this.d.masumi.submitResult(job.blockchain_identifier, job.output_hash);
    await markJobCompleted(this.d.sql, job.id);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/gateway exec vitest run && pnpm --filter @hirakumi/gateway typecheck`
Expected: PASS (all gateway tests, including mip003 12 and monitor 5), typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): MIP-003 endpoints and escrow job runner that submits only passing results" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Settlement reconciler for pending tokens

**Files:**
- Create: `apps/gateway/src/reconcile.ts`
- Test: `apps/gateway/test/reconcile.test.ts`

**Interfaces:**
- Consumes: `listPendingPayments(sql, minAgeSeconds)`, `activateTokenById` (`@hirakumi/db`); `USDM_PREPROD_ASSET` (`@x402/cardano`); Blockfrost `GET /txs/{hash}/utxos` → `{ outputs: [{ address, amount: [{ unit, quantity }] }] }` (404 when the tx is unknown).
- Produces:
  - `export type ChainOutput = { address: string; amount: Array<{ unit: string; quantity: string }> }`
  - `export type ChainLookup = (txHash: string) => Promise<{ found: false } | { found: true; outputs: ChainOutput[] }>`
  - `export const BLOCKFROST_PREPROD = "https://cardano-preprod.blockfrost.io/api/v0"`
  - `export const USDM_PREPROD_UNIT: string` (`USDM_PREPROD_ASSET` without the dot)
  - `export function blockfrostLookup(projectId: string, baseUrl?: string, fetchImpl?: typeof fetch): ChainLookup`
  - `export function paidTo(outputs: ChainOutput[], address: string, unit: string): bigint`
  - `export class Reconciler { constructor(d: { sql: Sql; lookup: ChainLookup; minAgeSeconds?: number; intervalMs?: number }); start(): void; stop(): void; tick(): Promise<{ checked: number; activated: number }> }`

Rule: a pending token becomes active only when the chain shows its transaction paying the seller **at least the pack price in tUSDM**. That covers the "settlement unknown" case (facilitator timeout or `settlement_pending`). A transaction that never landed stays pending forever, and so the token can never be used.

- [ ] **Step 1: Verify the Blockfrost response shape on a real spike transaction**

```bash
curl -s -H "project_id: $BLOCKFROST_PROJECT_ID" https://cardano-preprod.blockfrost.io/api/v0/txs/<tx from Task 0>/utxos | jq '{outputs: [.outputs[] | {address, amount}]}'
curl -s -o /dev/null -w "%{http_code}\n" -H "project_id: $BLOCKFROST_PROJECT_ID" https://cardano-preprod.blockfrost.io/api/v0/txs/$(printf '0%.0s' {1..64})/utxos
```
Expected: the first prints outputs, one of which has unit `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d`; the second prints `404`.

- [ ] **Step 2: Write the failing test**

`apps/gateway/test/reconcile.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockfrostLookup, paidTo, Reconciler, USDM_PREPROD_UNIT, type ChainLookup } from "../src/reconcile";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

async function pendingWithTx(tx: string, ageMinutes = 10) {
  const t = await insertActiveToken(h.sql, h.seeded, 100, "pending");
  await h.sql`update credit_tokens set tx_hash = ${tx}, created_at = now() - (${ageMinutes} * interval '1 minute') where id = ${t.id}`;
  return t.id;
}
const statusOf = async (id: string) => (await h.sql<{ status: string }[]>`select status from credit_tokens where id = ${id}`)[0].status;

describe("Reconciler", () => {
  it("activates a pending token whose tx pays the seller the pack price", async () => {
    const id = await pendingWithTx("aa".repeat(32));
    const lookup: ChainLookup = async () => ({ found: true, outputs: [
      { address: h.seeded.payTo, amount: [{ unit: "lovelace", quantity: "1400000" }, { unit: USDM_PREPROD_UNIT, quantity: "2000000" }] },
    ] });
    expect(await new Reconciler({ sql: h.sql, lookup }).tick()).toEqual({ checked: 1, activated: 1 });
    expect(await statusOf(id)).toBe("active");
  });
  it("leaves it pending when the tx is unknown, underpays, or pays someone else", async () => {
    const id = await pendingWithTx("bb".repeat(32));
    const cases: ChainLookup[] = [
      async () => ({ found: false }),
      async () => ({ found: true, outputs: [{ address: h.seeded.payTo, amount: [{ unit: USDM_PREPROD_UNIT, quantity: "1999999" }] }] }),
      async () => ({ found: true, outputs: [{ address: "addr_test1qsomeoneelse", amount: [{ unit: USDM_PREPROD_UNIT, quantity: "2000000" }] }] }),
    ];
    for (const lookup of cases) await new Reconciler({ sql: h.sql, lookup }).tick();
    expect(await statusOf(id)).toBe("pending");
  });
  it("ignores tokens younger than minAgeSeconds (the settle hook gets the first chance)", async () => {
    await pendingWithTx("cc".repeat(32), 0);
    let calls = 0;
    const lookup: ChainLookup = async () => { calls += 1; return { found: false }; };
    expect(await new Reconciler({ sql: h.sql, lookup, minAgeSeconds: 120 }).tick()).toEqual({ checked: 0, activated: 0 });
    expect(calls).toBe(0);
  });
});

describe("blockfrostLookup and paidTo", () => {
  it("maps 404 to not found and 200 to outputs, sending the project id", async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), key: new Headers(init?.headers).get("project_id") });
      return String(url).includes("/txs/00")
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify({ outputs: [{ address: "addr_test1qx", amount: [{ unit: "lovelace", quantity: "5" }], output_index: 0 }] }), { status: 200 });
    }) as typeof fetch;
    const look = blockfrostLookup("preprodKEY", "https://bf.test", fake);
    expect(await look("00ff")).toEqual({ found: false });
    expect(await look("11ff")).toEqual({ found: true, outputs: [{ address: "addr_test1qx", amount: [{ unit: "lovelace", quantity: "5" }] }] });
    expect(seen[1]).toEqual({ url: "https://bf.test/txs/11ff/utxos", key: "preprodKEY" });
  });
  it("paidTo sums one unit across outputs to one address", () => {
    expect(paidTo([
      { address: "a", amount: [{ unit: "u", quantity: "2" }] },
      { address: "a", amount: [{ unit: "u", quantity: "3" }, { unit: "v", quantity: "9" }] },
      { address: "b", amount: [{ unit: "u", quantity: "7" }] },
    ], "a", "u")).toBe(5n);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/reconcile.test.ts`
Expected: FAIL, `Failed to resolve import "../src/reconcile"`.

- [ ] **Step 4: Implement**

`apps/gateway/src/reconcile.ts`:
```ts
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { activateTokenById, listPendingPayments, type Sql } from "@hirakumi/db";

export type ChainOutput = { address: string; amount: Array<{ unit: string; quantity: string }> };
export type ChainLookup = (txHash: string) => Promise<{ found: false } | { found: true; outputs: ChainOutput[] }>;

export const BLOCKFROST_PREPROD = "https://cardano-preprod.blockfrost.io/api/v0";
export const USDM_PREPROD_UNIT = USDM_PREPROD_ASSET.replace(".", "");

export function blockfrostLookup(projectId: string, baseUrl: string = BLOCKFROST_PREPROD, fetchImpl: typeof fetch = fetch): ChainLookup {
  return async (txHash) => {
    const res = await fetchImpl(`${baseUrl}/txs/${txHash}/utxos`, { headers: { project_id: projectId } });
    if (res.status === 404) return { found: false };
    if (!res.ok) throw new Error(`Blockfrost answered ${res.status} for ${txHash}`);
    const body = (await res.json()) as { outputs: ChainOutput[] };
    return { found: true, outputs: body.outputs.map((o) => ({ address: o.address, amount: o.amount })) };
  };
}

export function paidTo(outputs: ChainOutput[], address: string, unit: string): bigint {
  let total = 0n;
  for (const o of outputs) {
    if (o.address !== address) continue;
    for (const a of o.amount) if (a.unit === unit) total += BigInt(a.quantity);
  }
  return total;
}

export class Reconciler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly minAgeSeconds: number;
  private readonly intervalMs: number;
  constructor(private readonly d: { sql: Sql; lookup: ChainLookup; minAgeSeconds?: number; intervalMs?: number }) {
    this.minAgeSeconds = d.minAgeSeconds ?? 120;
    this.intervalMs = d.intervalMs ?? 60_000;
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick().catch((e) => console.error("[reconcile]", e)); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<{ checked: number; activated: number }> {
    if (this.running) return { checked: 0, activated: 0 };
    this.running = true;
    let checked = 0;
    let activated = 0;
    try {
      for (const p of await listPendingPayments(this.d.sql, this.minAgeSeconds)) {
        checked += 1;
        const r = await this.d.lookup(p.tx_hash);
        if (!r.found) continue;
        const paid = paidTo(r.outputs, p.pay_to, USDM_PREPROD_UNIT);
        if (paid >= BigInt(p.price_micros)) {
          if (await activateTokenById(this.d.sql, p.id)) activated += 1;
          console.log(`[reconcile] token ${p.id} activated from chain tx ${p.tx_hash}`);
        } else {
          console.warn(`[reconcile] tx ${p.tx_hash} pays ${paid} of ${p.price_micros} to the seller; token ${p.id} stays pending`);
        }
      }
    } finally {
      this.running = false;
    }
    return { checked, activated };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @hirakumi/gateway exec vitest run test/reconcile.test.ts && pnpm --filter @hirakumi/gateway typecheck`
Expected: PASS (5 tests), typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): reconcile pending credit tokens against the chain" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Wire Masumi, JobRunner and Reconciler into the process, then the **hour-16 escrow run**

**Files:**
- Create: `apps/gateway/src/masumi-live.ts`, `apps/gateway/scripts/escrow-buyer.ts`
- Modify: `apps/gateway/package.json` (add `"@hirakumi/masumi": "workspace:*"`), `apps/gateway/src/main.ts` (full replacement)
- Test: `pnpm test` (all units) plus the manual preprod escrow run below.

**Interfaces:**
- Consumes the `@hirakumi/masumi` contract (P4):
  - `type MasumiConfig = { baseUrl: string; token: string; network: "Preprod" }`
  - `createPaymentRequest(c, p)`, `getPaymentState(c, id)`, `submitResult(c, id, resultHash)`
  - `createPurchase(c, p)` (demo buyer only)
- Produces: `export function masumiPortFrom(c: { baseUrl: string; token: string }): MasumiPort`

- [ ] **Step 1: Check that P4's package exists (precondition)**

```bash
test -f packages/masumi/package.json && grep -n '"name": "@hirakumi/masumi"' packages/masumi/package.json
grep -nE "export (async )?function (createPaymentRequest|getPaymentState|submitResult|createPurchase)" packages/masumi/src/*.ts
```
Expected: the name line and four function lines. If they're missing, P4 hasn't pushed `packages/masumi` yet. `git pull` and ask P4. Don't create the package yourself; P4 owns it. Everything up to Task 14 runs without it (`masumi: null` makes `start_job` answer 503 `escrow_unavailable`).

- [ ] **Step 2: Add the dependency and the binding**

In `apps/gateway/package.json` `dependencies`, add `"@hirakumi/masumi": "workspace:*"`, then run `pnpm install`.

`apps/gateway/src/masumi-live.ts`:
```ts
import { createPaymentRequest, getPaymentState, submitResult } from "@hirakumi/masumi";
import type { MasumiPort } from "./masumi-port";

export function masumiPortFrom(c: { baseUrl: string; token: string }): MasumiPort {
  const cfg = { baseUrl: c.baseUrl, token: c.token, network: "Preprod" as const };
  return {
    createPaymentRequest: (p) => createPaymentRequest(cfg, p),
    getPaymentState: (id) => getPaymentState(cfg, id),
    submitResult: (id, hash) => submitResult(cfg, id, hash),
  };
}
```

`apps/gateway/src/main.ts` (full file):
```ts
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createDb, migrate } from "@hirakumi/db";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { HealthTracker } from "./health";
import { JobRunner } from "./jobs";
import { masumiPortFrom } from "./masumi-live";
import { Monitor } from "./monitor";
import { blockfrostLookup, Reconciler } from "./reconcile";
import { ApiRegistry } from "./registry";

const config = loadConfig();
const sql = createDb(config.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log(`[gateway] migrations applied: ${applied.join(", ")}`);

const health = new HealthTracker(config.thresholds);
const registry = new ApiRegistry(sql, health);
const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
const masumi = config.masumi ? masumiPortFrom(config.masumi) : null;
if (!masumi) console.warn("[gateway] PAYMENT_SERVICE_URL/TOKEN not set: start_job answers 503 escrow_unavailable");

const app = createApp({ sql, config, registry, health, facilitator, masumi });
const monitor = new Monitor({ sql, registry, health, config });
monitor.start();
const jobs = masumi ? new JobRunner({ sql, registry, masumi, config }) : null;
jobs?.start();
const reconciler = config.blockfrostProjectId ? new Reconciler({ sql, lookup: blockfrostLookup(config.blockfrostProjectId) }) : null;
reconciler?.start();
if (!reconciler) console.warn("[gateway] BLOCKFROST_PROJECT_ID not set: pending tokens are activated only by the settle hook");

const server = app.listen(config.port, () => {
  console.log(`[gateway] listening on :${config.port} public=${config.publicBaseUrl} demo=${config.demoMode} ` +
    `probe=${config.probeIntervalMs / 1000}s escrow=${masumi ? "on" : "off"} reconcile=${reconciler ? "on" : "off"}`);
});

const shutdown = async () => {
  monitor.stop();
  jobs?.stop();
  reconciler?.stop();
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
```

`apps/gateway/scripts/escrow-buyer.ts` (demo escrow buyer using the payment node's purchasing wallet):
```ts
import { randomBytes } from "node:crypto";
import { createPurchase } from "@hirakumi/masumi";

const [base, apiId, symbol = "ADA"] = process.argv.slice(2);
const baseUrl = process.env.PAYMENT_SERVICE_URL?.trim() ?? "";
const token = process.env.PAYMENT_SERVICE_TOKEN?.trim() ?? "";
if (!base || !apiId || !baseUrl || !token) {
  console.error("usage: tsx scripts/escrow-buyer.ts <gatewayBase> <apiId> [symbol]  (needs PAYMENT_SERVICE_URL/TOKEN)");
  process.exit(1);
}
const pid = randomBytes(10).toString("hex");
const started = await fetch(`${base}/a/${apiId}/start_job`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ input_data: { symbol }, identifier_from_purchaser: pid }),
});
const job = (await started.json()) as Record<string, string | number>;
console.log(`start_job → ${started.status}`, JSON.stringify(job));
if (!started.ok) process.exit(1);

const { purchaseId } = await createPurchase({ baseUrl, token, network: "Preprod" }, {
  agentIdentifier: String(job.agentIdentifier), blockchainIdentifier: String(job.blockchainIdentifier),
  inputHash: String(job.input_hash), identifierFromPurchaser: pid, sellerVKey: String(job.sellerVKey),
  payByTime: new Date(Number(job.payByTime)), submitResultTime: new Date(Number(job.submitResultTime)),
  unlockTime: new Date(Number(job.unlockTime)), externalDisputeUnlockTime: new Date(Number(job.externalDisputeUnlockTime)),
  amountMicros: BigInt(process.env.ESCROW_PRICE_MICROS ?? "1000000"),
});
console.log(`purchase ${purchaseId} created; funds lock on chain next`);

for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  const s = (await (await fetch(`${base}/a/${apiId}/status?job_id=${job.job_id}`)).json()) as { status: string };
  console.log(`${new Date().toISOString()} status=${s.status}`);
  if (s.status === "completed" || s.status === "failed") { console.log(JSON.stringify(s, null, 2)); break; }
}
```

- [ ] **Step 3: Typecheck and run every test**

Run: `pnpm typecheck && pnpm test`
Expected: exit 0; all db, core and gateway suites PASS.

- [ ] **Step 4: Hour-16 escrow run on preprod (manual, on EC2 behind Caddy)**

The registry requires HTTPS, so run this where `PUBLIC_BASE_URL` is the Caddy domain (P4's compose). P4 registers the agent with `apiBaseUrl = ${PUBLIC_BASE_URL}/a/<apiId>` and gives you the `agent_identifier`.
```bash
psql "$DATABASE_URL" -c "update apis set agent_identifier = '<agentIdentifier>' where id = '<apiId>'"
curl -s -X POST -H "authorization: Bearer $INTERNAL_TOKEN" "$PUBLIC_BASE_URL/internal/apis/<apiId>/reload"
curl -s "$PUBLIC_BASE_URL/a/<apiId>/availability"            # expect 200 {"status":"available",…}
curl -s "$PUBLIC_BASE_URL/a/<apiId>/input_schema"            # expect {"input_data":[{"id":"symbol",…}]}
# PASS path
pnpm --filter @hirakumi/gateway exec tsx --env-file=../../.env scripts/escrow-buyer.ts "$PUBLIC_BASE_URL" <apiId> ADA
```
Expected: `start_job → 200` → `status=awaiting_payment` … → `status=running` → `status=completed` with `output_hash`. In the gateway log: no `[jobs]` errors. Check `psql -c "select kind, verdict, job_id from calls where kind='escrow' order by created_at desc limit 1"` → `escrow | pass`.

FAIL path (auto refund):
```bash
# break the seller ({} mode) with P5's switch, then:
pnpm --filter @hirakumi/gateway exec tsx --env-file=../../.env scripts/escrow-buyer.ts "$PUBLIC_BASE_URL" <apiId> ADA
```
Expected: `status=failed` with `"error":"promise_not_met"` and `reasons` containing `/price is missing`, plus no `submitResult` call (the gateway log shows no submit). After `submitResultTime` (20 min in demo mode), P4 confirms that the purchase moves to the refund state on the payment node. Record both blockchain identifiers in team chat: "Hour-16 gate: escrow pass ✅ / auto-refund ✅".

- [ ] **Step 5: Commit**

```bash
git add apps/gateway pnpm-lock.yaml
git commit -m "feat(gateway): wire Masumi escrow runner and chain reconciler into the process" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (P1 parts):**

| Spec item | Where |
|---|---|
| §12 spike: tUSDM settle via hosted facilitator, hooks fire, `l1Confirmations: 0` timing, two outputs | Task 0 Steps 4–8 (+ settle-failure hook unit test in Task 9) |
| §6.1.1 400 / 503 / 402 before payment | Task 8 (`400 for bad input`, `503 before 402`, `402 with pack offers`) |
| §6.1.2 x402 pack route: `payTo` = seller, tUSDM, `extra {apiId, packId, calls, ruleHash, ruleUrl}` | Task 9 (`402 offers tUSDM to the seller's verified address …`) |
| §6.1.3 pending token, `onAfterSettle` activates, `onSettleFailure` leaves pending | Task 9 (`pays, settles, activates`, `settle failure leaves the token pending`) |
| §6.1.4 atomic reserve, proxy, rule, commit 200 + `X-Credits-Remaining` / release 422/502/504 | Task 5 (race, revive), Task 8 (all status codes, HTTP race) |
| §6.1.5 evidence row per call: MIP-004 hashes keyed by token id, rule id, verdict, latency | Task 8 (`evidence logged keyed by token id`) |
| §6.2 MIP-003 start_job/status/availability/input_schema; poll FundsLocked → upstream → rule → submit or not | Task 10 (availability), Task 13 (all four, runner) |
| §7 probes with saved inputs, full rule, 3/2 prod and 2/2 demo, 10s/120s, truthful `/availability`, 503 on x402 and start_job | Task 6 (thresholds), Task 10, Task 13 (`start_job 503`) |
| §7 alerts on state change | Task 10 writes `health_events` with `{op, reason, since}`; P3 posts the comment |
| §8 speed: indexed token hash, one `UPDATE … RETURNING`, ajv compiled once per rule hash, keep-alive undici pool, 503/402/400 from memory, `/availability` from memory | Tasks 3, 4, 5, 7, 8, 10 |
| §11 edge cases: replay, concurrent last credit, 5xx/timeout release, settlement unknown → reconcile, buyer never locks → expire, slow upstream capped at 15s, flaky network needs a run of failures, probe header, SSRF, 256 KB/1 MB | Tasks 4, 5, 8, 9, 10, 13, 14 |
| §10 data model / contract SQL verbatim | Task 1 Step 2 (diff check) |
| Contract internal routes (preview, challenge check, reload, health) and `/r/:ruleHash` | Task 11, Task 8 |
| Contract checkpoint hour 10 (packs → credits → 200/422/503 on preprod) and hour 16 (escrow, availability flips) | Task 12 Step 6, Task 15 Step 4 |

**Placeholder scan:** every code step has complete code. The angle-bracket values in the manual runs (`<apiId>`, `<tx from Task 0>`, `<agentIdentifier>`) are runtime outputs printed by earlier steps, not missing design.

**Type consistency:**
- `LoadedOp`/`LoadedApi`/`AppDeps`/`MasumiPort` are defined in Task 7 and used unchanged in Tasks 8–15.
- `HealthReason {op, reason}` (gateway memory) and `HealthEventReason {op, reason, since}` (DB) are distinct, and `Monitor` converts between them.
- `runOperation(api, op, input, { timeoutMs, probe? })` has the same signature at every call site (credits, monitor, internal preview, jobs).

**Contract ambiguities resolved here (tell the owners):**
1. `operations.input_schema` shape is unspecified. This plan requires a flat JSON Schema object whose `properties` hold path, query and body fields (P3).
2. `apis.escrow_op_id` could hold either id. The gateway accepts `operations.id` or `op_id` (P2/P3 should store `operations.id`).
3. A pack's single `ruleHash` is the escrow operation's rule (`primaryRule`).
4. `health_events.reasons` is `[{op, reason, since}]` (P3 reads it).
5. Replay of a pack payment answers **409**, because raw tokens are stored hashed. The spec's "returns the existing token" isn't possible.
6. `rules.hash` is `UNIQUE`, so two APIs with byte-identical inferred rules can't both be stored. The test harness avoids this with a fresh schema per test. P3 should be aware (a fix would be a contract change: unique on `(operation_id, version)` only).
7. `submitResult` hash: this plan sends the 64-hex output hash, following the demo's `resultHash`. The skill reference's `inputHash+outputHash` form is P4's adapter decision.
8. `ALLOW_INSECURE_UPSTREAM` also admits `http://127.0.0.1`, not only `localhost`.
9. Who calls `/internal/apis/:apiId/reload`: P2/P3 must call it after any write that changes an API's state, operations, rules or packs. The cache also expires after 60s.

**Unverifiable from here (each has a verification step):**
- Facilitator behaviour on preprod: settle timing, the hooks firing, 422 leaving buyer UTxOs unspent, output count (Task 0).
- postgres.js `connection.search_path` (Task 1 Step 7).
- ajv default-import shape (Task 3 Step 1).
- undici passing `connect.lookup` through (Task 4 Step 4).
- Blockfrost `/txs/{hash}/utxos` shape (Task 14 Step 1).
- Masumi payment-service field names and the identifier-format rule (P4, Task 15 Step 1 precondition).
- Auto-refund after `submitResultTime` (P4, Task 15 Step 4).
