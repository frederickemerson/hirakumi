# Hirakumi P5 — Demo, Buyers & Pitch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Contract v1.1:** read the "Contract v1.1 amendments" section at the end of `2026-10-06-hirakumi-00-contract.md` before starting. It changes: the `start_job` times are epoch-millisecond **numbers**, not strings (G7); `cre/` is not a workspace member (B3).

**Goal:** Build everything the judges see from the outside: a real demo seller (`sellers/price-api`) with a break switch and an ownership file, two buyer agents (`agents/buyer`: x402 pack buyer and Masumi escrow buyer) that show "pay once, credits used only on pass" and "escrow refund on fail" on Cardano preprod, the full submission kit (demo script, recording checklist, slides, write-up, README, submission checklist), and, only if the hour-18 gate passes, a Chainlink CRE scorer run in simulation that writes API scores to Base Sepolia.

**Architecture:** The price API is a standalone Express 5 app deployed on Vercel. Its break mode is stored in Upstash Redis so every Vercel instance sees the same mode. The buyer is a pnpm workspace package of small pure modules (gateway client, pack chooser, serial payer, token store, flows), with all I/O injected so vitest can drive it against a fake gateway. Real payments go through `@x402/fetch` `wrapFetchWithPayment` with explicit spend controls for `USDM_PREPROD_ASSET`. Escrow goes through `@hirakumi/masumi` `createPurchase` (P4). The CRE scorer is a standalone Bun project under `cre/` with a Foundry consumer contract under `contracts/score-registry`.

**Tech Stack:** Node 22, TypeScript (ESM), pnpm workspaces, vitest, Express 5, supertest, `@upstash/redis`, `@x402/fetch` / `@x402/cardano` / `@x402/core` pinned to exactly `2.26.0`, `@hirakumi/core` (P1), `@hirakumi/masumi` (P4), Vercel CLI. Stretch: Bun ≥ 1.2.21, CRE CLI, `@chainlink/cre-sdk`, viem, Foundry, Base Sepolia.

**Spec:** `docs/superpowers/specs/2026-10-06-hirakumi-design.md` (v4) — §6.1 packs, §6.2 escrow, §13 demo.
**Contract:** `docs/superpowers/plans/2026-10-06-hirakumi-00-contract.md` (wins on any conflict).

---

## Global Constraints (exact values from contract)

- Network **`cardano:preprod` only**. Every address must start with `addr_test1`. The buyer refuses to start if its wallet address does not.
- **All `@x402/*` packages pinned to exactly `2.26.0`** (`pnpm add -E`). Never `^`.
- Node **22+**, TypeScript, ESM (`"type": "module"`), `tsx` to run, **vitest** for tests (exception: the stretch CRE workflow is a Bun project tested with `bun test`, see contract addition A7).
- Package manager **pnpm** workspaces. P5 owns `sellers/price-api`, `agents/buyer`, `cre/scorer` (stretch), and `contracts/score-registry` (stretch, new).
- Facilitator: `https://x402.preprod.dev.ecosyseng.cf-deployments.org` (its `/supported` endpoint answered HTTP 200 on 6 Oct). Local fallback: `npm run facilitator`, port 4022.
- **Two different preprod USDM tokens. Never mix them up:**
  - **Pack payments (x402):** `USDM_PREPROD_ASSET` from `@x402/cardano` = `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d` (checked in the installed `@x402/cardano@2.26.0` `index.d.mts`). Claim at https://tusdm.moneta.global.
  - **Escrow jobs (Masumi):** `MASUMI_ESCROW_UNIT=16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`.
- Both have 6 decimals. Amounts are integer **micros** (`bigint` in code, `string` in JSON).
- Gateway public routes used by P5: `GET /a/:apiId/x/:opId`, `POST /a/:apiId/packs/:packId`, `POST /a/:apiId/start_job`, `GET /a/:apiId/status?job_id=`, `GET /a/:apiId/availability`, `GET /r/:ruleHash`. 402 body: `{ error: "credits_required", packs: [{packId, calls, price, asset, buyUrl}], ruleHash, ruleUrl }`. 200 carries `X-Credits-Remaining`. 422 body: `{ error: "promise_not_met", reasons }`.
- Ownership file path: `/.well-known/hirakumi/<apiId>.txt` (`httpChallengePath`).
- Monitor demo mode `DEMO_MODE=1`: 10s interval, 2 fails → Down, 2 passes → healthy.
- Env vars used by P5 (shared names from contract): `PUBLIC_BASE_URL`, `BUYER_MNEMONIC`, `BLOCKFROST_PROJECT_ID`, `MASUMI_ESCROW_UNIT`, `SELLER_DEMO_ADDRESS`, `DEMO_MODE`.
- Copy rule: user-facing text is plain English. Say "promise", "credits", "Live / Down".
- Deadline: **7 Oct 2026, 23:59 SGT**. Internal submit target is 21:00 SGT.

### Contract additions P5 needs (post in team chat at hour 0–2; P1/P4 confirm)

| # | Addition | Owner | Why P5 needs it |
|---|---|---|---|
| A1 | 422, 502 and 504 responses to a call **with a valid token** also carry `X-Credits-Remaining` (the value after the credit is released) | P1 | Lets the buyer prove on screen that a refusal used no credit. Without it, the buyer can only confirm this on the next 200 (the code handles both cases). |
| A2 | Token states on `/a/:apiId/x/:opId`: pending → **401** `{error:"token_pending"}`; unknown or revoked → **401** `{error:"invalid_token"}`; exhausted → **402** `credits_required` | P1 | The buyer must wait for settlement and not re-pay. |
| A3 | In the 402 body, `packs[].price` is a micros string, `packs[].asset` is `USDM_PREPROD_ASSET`, `buyUrl` and `ruleUrl` are absolute or root-relative URLs | P1 | The buyer checks the asset and spend cap before paying. |
| A4 | `POST /a/:apiId/start_job` request `{ identifier_from_purchaser: string, input_data: object }` (escrow op input as a flat object, e.g. `{"symbol":"ADA"}`). Response `{ job_id, blockchainIdentifier, payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime, agentIdentifier, sellerVKey, input_hash, amounts: [{amount, unit}] }`. All four times are epoch-millisecond **strings**; `amount` is micros string; `unit` is `MASUMI_ESCROW_UNIT`; `input_hash` = `inputHash(identifier_from_purchaser, input_data)` from `@hirakumi/core` | P1 | The buyer passes these fields to `createPurchase` and checks the input hash and token unit before locking any funds. |
| A5 | `GET /a/:apiId/status?job_id=` → `{ job_id, status, output?, output_hash?, reasons?, message? }`, where `status` ∈ `awaiting_payment|running|completed|failed|expired`, `output` is the raw upstream body string, and `output_hash = outputHash(identifier_from_purchaser, output)` | P1 | The buyer prints the result and checks its hash. |
| A6 | The payment service is reachable from the demo laptop via `ssh -N -L 3001:127.0.0.1:3001 ec2-user@<EC2 host>` (compose publishes `127.0.0.1:3001:3001`), with a purchasing-capable API key for the buyer | P4 | The escrow buyer calls `createPurchase` from the laptop. |
| A7 | `pnpm-workspace.yaml` packages become `["apps/*", "packages/*", "sellers/*", "agents/*"]`. `cre/` is a standalone Bun project (its CLI toolchain is Bun-only), and `contracts/` holds the Foundry project | P1 (owns root) | A root `pnpm install` must not need Bun or the CRE CLI. |
| A8 | `.env.example` gains: `ADMIN_TOKEN`, `HIRAKUMI_CHALLENGE`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `COINGECKO_API_KEY` (optional), `PRICE_API_URL`, `BUYER_PAYMENT_SERVICE_URL=http://localhost:3001/api/v1`, `BUYER_PAYMENT_SERVICE_TOKEN`, `MAX_PACK_MICROS=5000000`, `MAX_ESCROW_MICROS=5000000`, `BLOCKFROST_BASE_URL=https://cardano-preprod.blockfrost.io/api/v0` | P1 (owns file) | The new P5 variables. |
| A9 | P1's `inferRule` uses `maxAgeSeconds` between **600 and 3000** for the price `timestamp` | P1 | Stale mode (1 hour old) must fail the promise. CoinGecko's `last_updated_at` can lag 1–5 minutes and must still pass. |

---

## Review Focus (5 failure modes most likely to bite users)

1. **The default x402 spend cap silently refuses the pack.** `USDM_PREPROD_ASSET` is a *default asset* in `@x402/cardano@2.26.0`, so without an explicit entry the client applies the top-level **$1** cap. A 2 tUSDM pack is rejected with "All payment requirements were rejected by spendControls.maxAmountPerPayment ($1, including USDM)". I verified this by running the real `x402Client` against a fake scheme on 6 Oct. The fix is an `allowedAssets` entry with an atomic `maxAmountPerPayment`. → **Test:** Task 8, `payClient.test.ts` "allows a 2 tUSDM pack and refuses 6 tUSDM under a 5 tUSDM cap" plus "the default controls refuse a 2 tUSDM pack".
2. **Sending the paid-operation call through `wrapFetchWithPayment`.** The gateway's 402 on `/x/:opId` is Hirakumi's own `credits_required` JSON, not an x402 `PaymentRequired`. The paying fetch must only ever see `buyUrl`. Op calls use plain `fetch`. → **Test:** Task 10, `packBuyer.test.ts` "op calls never hit /packs and buyPack only receives the buyUrl".
3. **The break switch flips only one Vercel instance.** In-memory mode works locally but fails on Vercel when a request lands on another instance, so the demo "break" never reaches the monitor. Mode lives in Redis, and on Vercel the app refuses to boot without it. → **Test:** Task 3, `app.admin.test.ts` "two app instances sharing one store see the same mode", and `modeStore.test.ts` "refuses memory store on Vercel".
4. **Mixing the two USDM tokens.** If a pack offer names the escrow unit, or an escrow job prices in the x402 unit, the buyer pays with the wrong token or the payment fails on-chain. Both buyers check the asset before paying. → **Tests:** Task 7 "choosePack refuses a pack priced in the escrow unit". Task 11 "refuses a job priced in the x402 pack asset without calling createPurchase".
5. **Two payments from one wallet at once.** The Cardano client signer uses the wallet's first UTxO as the nonce, so concurrent payments collide (agent brief gotcha 12). Every purchase goes through one `SerialPayer`. → **Test:** Task 8, `payClient.test.ts` "SerialPayer never runs two payments at once".

---

## File Structure

```
sellers/price-api/                      # P5, Vercel project root = this folder
  package.json                          # standalone (no workspace deps) so Vercel builds it alone
  tsconfig.json
  vercel.json                           # none needed; Express zero-config (see Task 6)
  src/index.ts                          # Vercel entry: builds deps from env, `export default app`
  src/dev.ts                            # local only: app.listen(PORT)
  src/createApp.ts                      # routes; NOT named app.ts (Vercel would pick src/app.ts first)
  src/priceSource.ts                    # CoinGecko + 30s cache + deterministic fallback
  src/modeStore.ts                      # break mode: memory (local/tests) | Upstash Redis (Vercel)
  src/challenge.ts                      # HIRAKUMI_CHALLENGE parsing
  src/openapi.ts                        # OpenAPI 3.1 document
  test/priceSource.test.ts
  test/modeStore.test.ts
  test/app.price.test.ts
  test/app.admin.test.ts
  test/app.meta.test.ts                 # openapi + challenge + healthz
agents/buyer/                           # P5
  package.json
  tsconfig.json
  .gitignore                            # .tokens.json
  src/gatewayClient.ts                  # FetchLike, 402 parsing, pack choice, call classification
  src/payClient.ts                      # spend controls, SerialPayer, real x402 pack payer
  src/tokenStore.ts                     # .tokens.json (0600)
  src/packBuyer.ts                      # runPackDemo flow
  src/escrowBuyer.ts                    # runEscrowJob flow
  src/env.ts                            # loads repo-root .env, required-var helper
  src/cli/pack.ts                       # `pnpm --filter @hirakumi/buyer pack -- ...`
  src/cli/escrow.ts                     # `pnpm --filter @hirakumi/buyer escrow -- ...`
  test/fakeGateway.ts                   # shared fake gateway for tests
  test/gatewayClient.test.ts
  test/payClient.test.ts
  test/tokenStore.test.ts
  test/packBuyer.test.ts
  test/escrowBuyer.test.ts
docs/submission/                        # P5 non-code deliverables
  demo-script.md
  recording-checklist.md
  slides-outline.md
  writeup.md
  submission-checklist.md
README.md                               # root README (P5 writes the final version)
# stretch, only after the hour-18 gate:
contracts/score-registry/               # Foundry
  foundry.toml
  src/ScoreRegistry.sol
  src/interfaces/{IReceiver.sol,IERC165.sol,ReceiverTemplate.sol}   # MIT, copied from smartcontractkit/x402-cre-price-alerts
  test/ScoreRegistry.t.sol
cre/                                    # CRE project root (standalone Bun)
  project.yaml
  secrets.yaml
  .gitignore                            # .env
  scorer/
    package.json
    tsconfig.json
    workflow.yaml
    config.staging.json                 # generated in Task 20
    main.ts
    logic.ts
    logic.test.ts
```

**Hour plan for P5:** Task 1 (hours 0–2) → Tasks 2–6 price API live by hour 4, which P1 needs for the hour-10 gate → Tasks 7–10 pack buyer by hour 9 → Task 12a rehearsal at the hour-10 gate → Task 11 escrow buyer by hour 14 → Task 12b at the hour-16 gate → Tasks 13–17 docs during hours 14–18 → Tasks 18–20 CRE during hours 18–22 **only if the gate passes** → record at hours 22–26 → submit.

---

### Task 1: Hour 0–2 kickoff (questions, wallets, accounts)

**Files:** none (team chat + accounts).
**Interfaces:** produces the env values used by every later task.

- [ ] **Step 1: Ask the organisers (hour 0–2, in person or on the event Discord)** and post the answers in team chat word for word:
  1. "How many tracks can one project enter? Can we submit to the main track and the Cardano 'Agentic Commerce' track with the same repo and video?"
  2. "Is the submission a single form with a track picker, or one submission per track?"
  3. "Is a Google Drive link acceptable for slides, and YouTube unlisted or Drive for the video?"
  4. "Do judges need a live URL that stays up after 7 Oct 23:59 SGT, and for how long?"
  Fallback if there's no answer by hour 2: enter the Cardano track only (spec §12).
- [ ] **Step 2: Post the contract additions A1–A9** (table above) in team chat. Get a thumbs-up from P1 for A1–A5, A7, A8, A9 and from P4 for A6.
- [ ] **Step 3: Create and fund the buyer wallet.**
  ```bash
  cd /tmp && npx giget@latest gh:cardano-foundation/developer-portal/examples/templates/x402-express x402-wallet && cd x402-wallet && npm install && npm run wallet
  ```
  Put the printed mnemonic in the repo-root `.env` as `BUYER_MNEMONIC=...`. Fund the printed `addr_test1...` address with:
  - ≥ 30 tADA from https://docs.cardano.org/cardano-testnets/tools/faucet (Preprod). Covers min-UTxO of about 1.2–1.5 ADA plus about 0.17 ADA fee per pack, with headroom for 10+ packs.
  - ≥ 20 tUSDM (x402 asset `USDM_PREPROD_ASSET`) from https://tusdm.moneta.global.
  Check on `https://preprod.cardanoscan.io/address/<addr>` that both tokens arrived.
- [ ] **Step 4: Confirm with P4** that the payment-service purchasing wallet holds escrow tUSDM (`MASUMI_ESCROW_UNIT`) and ≥ 20 tADA. Get `BUYER_PAYMENT_SERVICE_TOKEN` (a key allowed to create purchases) into `.env`.
- [ ] **Step 5: Accounts.** Vercel (team project `hirakumi-price-api`), Upstash Redis via Vercel Marketplace (Task 6), optional CoinGecko demo key (`COINGECKO_API_KEY`), Google Drive folder "Hirakumi submission" shared with the team, YouTube account for an unlisted upload.
- [ ] **Step 6: Generate the admin token** and put it in `.env`:
  ```bash
  echo "ADMIN_TOKEN=$(openssl rand -hex 24)" >> .env
  ```

---

### Task 2: price-api scaffold and price source (CoinGecko, 30s cache, fallback)

**Files:** Create `sellers/price-api/package.json`, `sellers/price-api/tsconfig.json`, `sellers/price-api/src/priceSource.ts`, `sellers/price-api/test/priceSource.test.ts`.

**Interfaces:**
```ts
export const SUPPORTED_SYMBOLS: readonly ["ADA", "BTC", "ETH", "SOL"];
export type SupportedSymbol = "ADA" | "BTC" | "ETH" | "SOL";
export type Quote = { symbol: SupportedSymbol; usd: number; change24h: number; timestamp: string; source: "coingecko" | "fallback" };
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export function isSupportedSymbol(x: string): x is SupportedSymbol;
export function createPriceSource(o: { fetch: FetchLike; now: () => number; ttlMs?: number; timeoutMs?: number; coingeckoApiKey?: string; onError?: (e: unknown) => void }): { get(s: SupportedSymbol): Promise<Quote> };
```

Verified source (probed 6 Oct): `GET https://api.coingecko.com/api/v3/simple/price?ids=cardano,bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true` → `{"cardano":{"usd":0.269505,"usd_24h_change":1.2466066400317077,"last_updated_at":1791262510},...}`.

- [ ] **Step 1: Scaffold the package.**
  ```bash
  mkdir -p sellers/price-api/src sellers/price-api/test && cd sellers/price-api
  cat > package.json <<'EOF'
  {
    "name": "@hirakumi/price-api",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "engines": { "node": ">=22" },
    "scripts": {
      "dev": "tsx watch src/dev.ts",
      "start": "tsx src/dev.ts",
      "test": "vitest run",
      "typecheck": "tsc --noEmit"
    }
  }
  EOF
  cat > tsconfig.json <<'EOF'
  {
    "compilerOptions": {
      "target": "ES2023",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "noEmit": true,
      "types": ["node"]
    },
    "include": ["src", "test"]
  }
  EOF
  pnpm add -E express@5 @upstash/redis
  pnpm add -DE @types/express@5 @types/node@22 supertest @types/supertest tsx typescript vitest
  ```
- [ ] **Step 2: Write the failing test** `sellers/price-api/test/priceSource.test.ts`:
  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { createPriceSource, isSupportedSymbol, type FetchLike } from "../src/priceSource.js";

  const NOW = Date.UTC(2026, 9, 6, 8, 0, 0);
  const cgBody = { cardano: { usd: 0.269505, usd_24h_change: 1.2466066400317077, last_updated_at: 1791262510 } };
  const okFetch = (body: unknown = cgBody) =>
    vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

  describe("priceSource", () => {
    it("maps a CoinGecko simple/price row to a quote", async () => {
      const fetch = okFetch();
      const src = createPriceSource({ fetch, now: () => NOW });
      const q = await src.get("ADA");
      expect(q).toEqual({ symbol: "ADA", usd: 0.269505, change24h: 1.25, timestamp: new Date(1791262510 * 1000).toISOString(), source: "coingecko" });
      const url = fetch.mock.calls[0][0];
      expect(url).toContain("ids=cardano");
      expect(url).toContain("include_24hr_change=true");
      expect(url).toContain("include_last_updated_at=true");
    });

    it("caches for 30 seconds", async () => {
      let now = NOW;
      const fetch = okFetch();
      const src = createPriceSource({ fetch, now: () => now });
      await src.get("ADA");
      now += 29_000;
      await src.get("ADA");
      expect(fetch).toHaveBeenCalledTimes(1);
      now += 2_000;
      await src.get("ADA");
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("falls back to a deterministic quote stamped now when CoinGecko rate-limits", async () => {
      const fetch = vi.fn<FetchLike>(async () => new Response("slow down", { status: 429 }));
      const onError = vi.fn();
      const src = createPriceSource({ fetch, now: () => NOW, onError });
      const q = await src.get("ADA");
      expect(q).toEqual({ symbol: "ADA", usd: 0.5, change24h: 0, timestamp: new Date(NOW).toISOString(), source: "fallback" });
      expect(onError).toHaveBeenCalledOnce();
    });

    it("falls back when the body is missing fields", async () => {
      const src = createPriceSource({ fetch: okFetch({ cardano: { usd: 0.27 } }), now: () => NOW });
      expect((await src.get("ADA")).source).toBe("fallback");
    });

    it("falls back when fetch throws (timeout, DNS)", async () => {
      const src = createPriceSource({ fetch: vi.fn<FetchLike>(async () => { throw new Error("timeout"); }), now: () => NOW });
      expect((await src.get("BTC")).usd).toBe(60000);
    });

    it("sends the demo API key header when configured", async () => {
      const fetch = okFetch();
      await createPriceSource({ fetch, now: () => NOW, coingeckoApiKey: "CG-test" }).get("ADA");
      const init = fetch.mock.calls[0][1];
      expect(new Headers(init?.headers).get("x-cg-demo-api-key")).toBe("CG-test");
    });

    it("knows its symbols", () => {
      expect(isSupportedSymbol("ADA")).toBe(true);
      expect(isSupportedSymbol("DOGE")).toBe(false);
    });
  });
  ```
- [ ] **Step 3: Run it, expect FAIL.**
  `pnpm --filter @hirakumi/price-api exec vitest run test/priceSource.test.ts`
  Expected: FAIL with `Failed to load url ../src/priceSource.js` (module does not exist).
- [ ] **Step 4: Implement** `sellers/price-api/src/priceSource.ts`:
  ```ts
  export const SUPPORTED_SYMBOLS = ["ADA", "BTC", "ETH", "SOL"] as const;
  export type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];
  export type Quote = { symbol: SupportedSymbol; usd: number; change24h: number; timestamp: string; source: "coingecko" | "fallback" };
  export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
  export type PriceSource = { get(symbol: SupportedSymbol): Promise<Quote> };

  const COINGECKO_IDS: Record<SupportedSymbol, string> = { ADA: "cardano", BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };
  // Deterministic fallback so the demo never depends on a third-party rate limit.
  const FALLBACK_USD: Record<SupportedSymbol, number> = { ADA: 0.5, BTC: 60000, ETH: 3000, SOL: 150 };

  export function isSupportedSymbol(x: string): x is SupportedSymbol {
    return (SUPPORTED_SYMBOLS as readonly string[]).includes(x);
  }

  function coingeckoUrl(id: string): string {
    const u = new URL("https://api.coingecko.com/api/v3/simple/price");
    u.searchParams.set("ids", id);
    u.searchParams.set("vs_currencies", "usd");
    u.searchParams.set("include_24hr_change", "true");
    u.searchParams.set("include_last_updated_at", "true");
    return u.toString();
  }

  export function createPriceSource(opts: {
    fetch: FetchLike;
    now: () => number;
    ttlMs?: number;
    timeoutMs?: number;
    coingeckoApiKey?: string;
    onError?: (err: unknown) => void;
  }): PriceSource {
    const ttlMs = opts.ttlMs ?? 30_000;
    const cache = new Map<SupportedSymbol, { fetchedAt: number; quote: Quote }>();

    async function live(symbol: SupportedSymbol): Promise<Quote> {
      const id = COINGECKO_IDS[symbol];
      const headers: Record<string, string> = { accept: "application/json" };
      if (opts.coingeckoApiKey) headers["x-cg-demo-api-key"] = opts.coingeckoApiKey;
      const res = await opts.fetch(coingeckoUrl(id), { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000) });
      if (!res.ok) throw new Error(`CoinGecko answered HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, Record<string, unknown> | undefined>;
      const row = body[id];
      const usd = row?.usd;
      const change = row?.usd_24h_change;
      const updated = row?.last_updated_at;
      if (typeof usd !== "number" || typeof change !== "number" || typeof updated !== "number") {
        throw new Error(`CoinGecko response for ${id} lacks usd, usd_24h_change or last_updated_at`);
      }
      return {
        symbol,
        usd,
        change24h: Math.round(change * 100) / 100,
        timestamp: new Date(updated * 1000).toISOString(),
        source: "coingecko",
      };
    }

    function fallback(symbol: SupportedSymbol): Quote {
      return { symbol, usd: FALLBACK_USD[symbol], change24h: 0, timestamp: new Date(opts.now()).toISOString(), source: "fallback" };
    }

    return {
      async get(symbol) {
        const now = opts.now();
        const hit = cache.get(symbol);
        if (hit && now - hit.fetchedAt < ttlMs) return hit.quote;
        let quote: Quote;
        try {
          quote = await live(symbol);
        } catch (err) {
          opts.onError?.(err);
          quote = fallback(symbol);
        }
        cache.set(symbol, { fetchedAt: now, quote });
        return quote;
      },
    };
  }
  ```
- [ ] **Step 5: Run, expect PASS.**
  `pnpm --filter @hirakumi/price-api exec vitest run test/priceSource.test.ts` → `7 passed`.
- [ ] **Step 6: Commit.**
  ```bash
  git add sellers/price-api pnpm-lock.yaml
  git commit -m "feat(price-api): CoinGecko price source with 30s cache and fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 3: break-mode store and admin switch

**Files:** Create `sellers/price-api/src/modeStore.ts`, `sellers/price-api/test/modeStore.test.ts`. (The admin route is written in Task 4's `createApp.ts`; its tests are in Task 4 Step 1 `app.admin.test.ts`.)

**Interfaces:**
```ts
export const BREAK_MODES: readonly ["ok", "empty", "stale"];
export type BreakMode = "ok" | "empty" | "stale";
export function isBreakMode(x: unknown): x is BreakMode;
export type ModeStore = { readonly kind: "memory" | "redis"; get(): Promise<BreakMode>; set(m: BreakMode): Promise<void> };
export type RedisLike = { get(key: string): Promise<unknown>; set(key: string, value: string): Promise<unknown> };
export const MODE_KEY = "hirakumi:price-api:mode";
export function memoryModeStore(initial?: BreakMode): ModeStore;
export function redisModeStore(r: RedisLike): ModeStore;
export function modeStoreFromEnv(env: Record<string, string | undefined>): ModeStore;
```

- [ ] **Step 1: Write the failing test** `sellers/price-api/test/modeStore.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { memoryModeStore, redisModeStore, modeStoreFromEnv, isBreakMode, MODE_KEY, type RedisLike } from "../src/modeStore.js";

  function fakeRedis(): RedisLike & { data: Map<string, unknown> } {
    const data = new Map<string, unknown>();
    return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); return "OK"; } };
  }

  describe("modeStore", () => {
    it("memory store defaults to ok and remembers a set", async () => {
      const s = memoryModeStore();
      expect(await s.get()).toBe("ok");
      await s.set("stale");
      expect(await s.get()).toBe("stale");
    });

    it("redis store reads and writes one key", async () => {
      const r = fakeRedis();
      const s = redisModeStore(r);
      expect(s.kind).toBe("redis");
      expect(await s.get()).toBe("ok");
      await s.set("empty");
      expect(r.data.get(MODE_KEY)).toBe("empty");
      expect(await s.get()).toBe("empty");
    });

    it("treats an unknown stored value as ok", async () => {
      const r = fakeRedis();
      r.data.set(MODE_KEY, "garbage");
      expect(await redisModeStore(r).get()).toBe("ok");
    });

    it("uses Redis when Upstash env vars are present", () => {
      expect(modeStoreFromEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }).kind).toBe("redis");
      expect(modeStoreFromEnv({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" }).kind).toBe("redis");
    });

    it("uses memory locally", () => {
      expect(modeStoreFromEnv({}).kind).toBe("memory");
    });

    it("refuses memory store on Vercel (break switch must be shared by every instance)", () => {
      expect(() => modeStoreFromEnv({ VERCEL: "1" })).toThrow(/UPSTASH_REDIS_REST_URL/);
    });

    it("validates modes", () => {
      expect(isBreakMode("empty")).toBe(true);
      expect(isBreakMode("broken")).toBe(false);
      expect(isBreakMode(3)).toBe(false);
    });
  });
  ```
- [ ] **Step 2: Run, expect FAIL.**
  `pnpm --filter @hirakumi/price-api exec vitest run test/modeStore.test.ts` → FAIL, cannot load `../src/modeStore.js`.
- [ ] **Step 3: Implement** `sellers/price-api/src/modeStore.ts`:
  ```ts
  import { Redis } from "@upstash/redis";

  export const BREAK_MODES = ["ok", "empty", "stale"] as const;
  export type BreakMode = (typeof BREAK_MODES)[number];
  export type ModeStore = { readonly kind: "memory" | "redis"; get(): Promise<BreakMode>; set(mode: BreakMode): Promise<void> };
  export type RedisLike = { get(key: string): Promise<unknown>; set(key: string, value: string): Promise<unknown> };
  export const MODE_KEY = "hirakumi:price-api:mode";

  export function isBreakMode(x: unknown): x is BreakMode {
    return typeof x === "string" && (BREAK_MODES as readonly string[]).includes(x);
  }

  export function memoryModeStore(initial: BreakMode = "ok"): ModeStore {
    let mode = initial;
    return {
      kind: "memory",
      async get() { return mode; },
      async set(m) { mode = m; },
    };
  }

  export function redisModeStore(redis: RedisLike): ModeStore {
    return {
      kind: "redis",
      async get() {
        const v = await redis.get(MODE_KEY);
        return isBreakMode(v) ? v : "ok";
      },
      async set(m) { await redis.set(MODE_KEY, m); },
    };
  }

  export function modeStoreFromEnv(env: Record<string, string | undefined>): ModeStore {
    const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
    if (url && token) return redisModeStore(new Redis({ url, token }));
    if (env.VERCEL) {
      throw new Error(
        "price-api on Vercel needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL/KV_REST_API_TOKEN): the break switch must be shared by every instance",
      );
    }
    return memoryModeStore();
  }
  ```
- [ ] **Step 4: Run, expect PASS.** Same command → `7 passed`.
- [ ] **Step 5: Commit.**
  ```bash
  git add sellers/price-api
  git commit -m "feat(price-api): shared break-mode store (Upstash on Vercel, memory locally)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 4: `/price`, `/admin/break`, `/healthz` routes (createApp)

**Files:** Create `sellers/price-api/src/createApp.ts`, `sellers/price-api/src/openapi.ts` (stub here, finished in Task 5), `sellers/price-api/src/challenge.ts` (finished in Task 5), `sellers/price-api/test/app.price.test.ts`, `sellers/price-api/test/app.admin.test.ts`.

**Interfaces:**
```ts
export const STALE_AGE_MS = 3_600_000;
export type AppDeps = { prices: PriceSource; modes: ModeStore; now: () => number; adminToken: string | undefined;
  challenges: Record<string, string>; publicUrl: string; log: (msg: string, err?: unknown) => void };
export function createApp(deps: AppDeps): import("express").Express;
```
Routes: `GET /price?symbol=` → 200 `{symbol, usd, change24h, timestamp}` (header `X-Price-Source`), 400 `{error:"unknown_symbol"}`; `POST /admin/break` `{mode}` with `Authorization: Bearer <ADMIN_TOKEN>` → 200 `{mode}` / 400 / 401 / 503; `GET /admin/break` → `{mode, store}`; `GET /healthz` → `{ok:true, modeStore}`.

- [ ] **Step 1: Write the failing tests.**
  `sellers/price-api/test/helpers.ts`:
  ```ts
  import { createApp, type AppDeps } from "../src/createApp.js";
  import { memoryModeStore, type ModeStore } from "../src/modeStore.js";
  import type { PriceSource, Quote } from "../src/priceSource.js";

  export const NOW = Date.UTC(2026, 9, 6, 8, 0, 0);
  export const ADMIN = "admin-token-0123456789abcdef";
  export const fixedPrices: PriceSource = {
    async get(symbol): Promise<Quote> {
      return { symbol, usd: 0.2695, change24h: 1.25, timestamp: new Date(NOW - 60_000).toISOString(), source: "coingecko" };
    },
  };
  export function makeApp(over: Partial<AppDeps> & { modes?: ModeStore } = {}) {
    return createApp({
      prices: fixedPrices,
      modes: memoryModeStore(),
      now: () => NOW,
      adminToken: ADMIN,
      challenges: {},
      publicUrl: "https://price.test",
      log: () => {},
      ...over,
    });
  }
  ```
  `sellers/price-api/test/app.price.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import request from "supertest";
  import { makeApp, ADMIN, NOW } from "./helpers.js";
  import { memoryModeStore, type ModeStore } from "../src/modeStore.js";

  describe("GET /price", () => {
    it("returns exactly symbol, usd, change24h, timestamp", async () => {
      const res = await request(makeApp()).get("/price?symbol=ADA");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ symbol: "ADA", usd: 0.2695, change24h: 1.25, timestamp: new Date(NOW - 60_000).toISOString() });
      expect(res.headers["x-price-source"]).toBe("coingecko");
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("accepts lowercase symbols", async () => {
      expect((await request(makeApp()).get("/price?symbol=ada")).body.symbol).toBe("ADA");
    });

    it("rejects unknown or missing symbols with 400", async () => {
      const app = makeApp();
      expect((await request(app).get("/price?symbol=DOGE")).status).toBe(400);
      const res = await request(app).get("/price");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("unknown_symbol");
    });

    it("empty mode returns {}", async () => {
      const res = await request(makeApp({ modes: memoryModeStore("empty") })).get("/price?symbol=ADA");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });

    it("stale mode returns a timestamp exactly one hour old", async () => {
      const res = await request(makeApp({ modes: memoryModeStore("stale") })).get("/price?symbol=ADA");
      expect(res.body.timestamp).toBe(new Date(NOW - 3_600_000).toISOString());
      expect(res.body.usd).toBe(0.2695);
    });

    it("serves normal data if the mode store is unreachable", async () => {
      const broken: ModeStore = { kind: "redis", get: async () => { throw new Error("redis down"); }, set: async () => {} };
      const res = await request(makeApp({ modes: broken })).get("/price?symbol=ADA");
      expect(res.status).toBe(200);
      expect(res.body.symbol).toBe("ADA");
    });

    it("break then fix round-trip through the admin switch", async () => {
      const app = makeApp();
      const auth = { Authorization: `Bearer ${ADMIN}` };
      await request(app).post("/admin/break").set(auth).send({ mode: "empty" }).expect(200);
      expect((await request(app).get("/price?symbol=ADA")).body).toEqual({});
      await request(app).post("/admin/break").set(auth).send({ mode: "ok" }).expect(200);
      expect((await request(app).get("/price?symbol=ADA")).body.symbol).toBe("ADA");
    });
  });
  ```
  `sellers/price-api/test/app.admin.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import request from "supertest";
  import { makeApp, ADMIN } from "./helpers.js";
  import { memoryModeStore } from "../src/modeStore.js";

  const auth = { Authorization: `Bearer ${ADMIN}` };

  describe("/admin/break", () => {
    it("401 without the right bearer token", async () => {
      const app = makeApp();
      expect((await request(app).post("/admin/break").send({ mode: "empty" })).status).toBe(401);
      expect((await request(app).post("/admin/break").set({ Authorization: "Bearer nope" }).send({ mode: "empty" })).status).toBe(401);
    });

    it("503 when ADMIN_TOKEN is not configured (never an open switch)", async () => {
      const res = await request(makeApp({ adminToken: undefined })).post("/admin/break").set(auth).send({ mode: "empty" });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("admin_disabled");
    });

    it("400 on an unknown mode", async () => {
      const res = await request(makeApp()).post("/admin/break").set(auth).send({ mode: "explode" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_mode");
    });

    it("GET reports the current mode and store kind", async () => {
      const app = makeApp();
      await request(app).post("/admin/break").set(auth).send({ mode: "stale" }).expect(200, { mode: "stale" });
      expect((await request(app).get("/admin/break").set(auth)).body).toEqual({ mode: "stale", store: "memory" });
    });

    it("two app instances sharing one store see the same mode (Vercel multi-instance)", async () => {
      const shared = memoryModeStore();
      const a = makeApp({ modes: shared });
      const b = makeApp({ modes: shared });
      await request(a).post("/admin/break").set(auth).send({ mode: "empty" }).expect(200);
      expect((await request(b).get("/price?symbol=ADA")).body).toEqual({});
    });

    it("healthz names the store so the deploy smoke test can catch memory on Vercel", async () => {
      expect((await request(makeApp()).get("/healthz")).body).toEqual({ ok: true, modeStore: "memory" });
    });
  });
  ```
- [ ] **Step 2: Run, expect FAIL.**
  `pnpm --filter @hirakumi/price-api exec vitest run test/app.price.test.ts test/app.admin.test.ts` → FAIL, cannot load `../src/createApp.js`.
- [ ] **Step 3: Implement.**
  `sellers/price-api/src/openapi.ts` (minimal now, full in Task 5):
  ```ts
  export function buildOpenApi(serverUrl: string): Record<string, unknown> {
    return { openapi: "3.1.0", info: { title: "Hirakumi Demo Price API", version: "1.0.0" }, servers: [{ url: serverUrl }], paths: {} };
  }
  ```
  `sellers/price-api/src/challenge.ts` (minimal now, full in Task 5):
  ```ts
  export function parseChallenges(_raw: string | undefined, _log: (msg: string) => void): Record<string, string> {
    return {};
  }
  ```
  `sellers/price-api/src/createApp.ts`:
  ```ts
  import express, { type Express, type Request, type Response, type NextFunction } from "express";
  import { createHash, timingSafeEqual } from "node:crypto";
  import { isSupportedSymbol, SUPPORTED_SYMBOLS, type PriceSource } from "./priceSource.js";
  import { isBreakMode, BREAK_MODES, type BreakMode, type ModeStore } from "./modeStore.js";
  import { buildOpenApi } from "./openapi.js";

  export const STALE_AGE_MS = 3_600_000;

  export type AppDeps = {
    prices: PriceSource;
    modes: ModeStore;
    now: () => number;
    adminToken: string | undefined;
    challenges: Record<string, string>;
    publicUrl: string;
    log: (msg: string, err?: unknown) => void;
  };

  function sameSecret(expected: string, given: string): boolean {
    const a = createHash("sha256").update(expected).digest();
    const b = createHash("sha256").update(given).digest();
    return timingSafeEqual(a, b);
  }

  export function createApp(deps: AppDeps): Express {
    const app = express();
    app.disable("x-powered-by");

    const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
      if (!deps.adminToken) {
        res.status(503).json({ error: "admin_disabled", message: "Set ADMIN_TOKEN to enable the break switch" });
        return;
      }
      const header = req.get("authorization") ?? "";
      const given = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!sameSecret(deps.adminToken, given)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      next();
    };

    app.get("/healthz", (_req, res) => {
      res.json({ ok: true, modeStore: deps.modes.kind });
    });

    app.get("/openapi.json", (_req, res) => {
      res.json(buildOpenApi(deps.publicUrl));
    });

    app.get("/price", async (req, res) => {
      const raw = typeof req.query.symbol === "string" ? req.query.symbol.trim().toUpperCase() : "";
      if (!isSupportedSymbol(raw)) {
        res.status(400).json({ error: "unknown_symbol", message: `symbol must be one of ${SUPPORTED_SYMBOLS.join(", ")}` });
        return;
      }
      const mode: BreakMode = await deps.modes.get().catch((err: unknown) => {
        deps.log("mode store read failed; serving normal data", err);
        return "ok" as const;
      });
      res.set("Cache-Control", "no-store");
      if (mode === "empty") {
        res.json({});
        return;
      }
      const quote = await deps.prices.get(raw);
      res.set("X-Price-Source", quote.source);
      const timestamp = mode === "stale" ? new Date(deps.now() - STALE_AGE_MS).toISOString() : quote.timestamp;
      res.json({ symbol: quote.symbol, usd: quote.usd, change24h: quote.change24h, timestamp });
    });

    app.post("/admin/break", requireAdmin, express.json({ limit: "1kb" }), async (req, res) => {
      const mode = (req.body as { mode?: unknown } | undefined)?.mode;
      if (!isBreakMode(mode)) {
        res.status(400).json({ error: "invalid_mode", message: `mode must be one of ${BREAK_MODES.join(", ")}` });
        return;
      }
      await deps.modes.set(mode);
      deps.log(`break mode set to ${mode}`);
      res.json({ mode });
    });

    app.get("/admin/break", requireAdmin, async (_req, res) => {
      res.json({ mode: await deps.modes.get(), store: deps.modes.kind });
    });

    app.get("/.well-known/hirakumi/:file", (req, res) => {
      const m = /^(api_[A-Za-z0-9]+)\.txt$/.exec(req.params.file);
      const apiId = m?.[1];
      if (!apiId || !Object.hasOwn(deps.challenges, apiId)) {
        res.status(404).type("text/plain").send("not found");
        return;
      }
      res.set("Cache-Control", "no-store").type("text/plain; charset=utf-8").send(deps.challenges[apiId]);
    });

    app.use((_req, res) => {
      res.status(404).json({ error: "not_found" });
    });

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      deps.log("unhandled error", err);
      res.status(500).json({ error: "internal_error" });
    });

    return app;
  }
  ```
- [ ] **Step 4: Run, expect PASS.** Same command → `13 passed`.
- [ ] **Step 5: Commit.**
  ```bash
  git add sellers/price-api
  git commit -m "feat(price-api): /price with empty and stale break modes, guarded admin switch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 5: OpenAPI 3.1 document and ownership challenge file

**Files:** Modify `sellers/price-api/src/openapi.ts`, `sellers/price-api/src/challenge.ts`. Create `sellers/price-api/test/app.meta.test.ts`.

**Interfaces:** `buildOpenApi(serverUrl): OpenAPI 3.1 object` with `paths["/price"].get.operationId === "getPrice"`; `parseChallenges(raw, log): Record<apiId, token>`; `GET /.well-known/hirakumi/<apiId>.txt` → `text/plain` token, byte-exact, no trailing newline.

- [ ] **Step 1: Write the failing test** `sellers/price-api/test/app.meta.test.ts`:
  ```ts
  import { describe, it, expect, vi } from "vitest";
  import request from "supertest";
  import { makeApp } from "./helpers.js";
  import { buildOpenApi } from "../src/openapi.js";
  import { parseChallenges } from "../src/challenge.js";

  describe("openapi.json", () => {
    it("is OpenAPI 3.1 with getPrice, examples and a response schema", async () => {
      const res = await request(makeApp()).get("/openapi.json");
      expect(res.status).toBe(200);
      const doc = res.body;
      expect(doc.openapi).toBe("3.1.0");
      expect(doc.servers[0].url).toBe("https://price.test");
      const op = doc.paths["/price"].get;
      expect(op.operationId).toBe("getPrice");
      const param = op.parameters[0];
      expect(param).toMatchObject({ name: "symbol", in: "query", required: true, example: "ADA" });
      expect(param.schema.enum).toEqual(["ADA", "BTC", "ETH", "SOL"]);
      const ok = op.responses["200"].content["application/json"];
      expect(ok.schema.$ref).toBe("#/components/schemas/Price");
      const schema = doc.components.schemas.Price;
      expect(schema.required).toEqual(["symbol", "usd", "change24h", "timestamp"]);
      const example = ok.examples.ada.value;
      for (const key of schema.required) expect(example).toHaveProperty(key);
      expect(op.responses["400"]).toBeDefined();
    });

    it("declares no side effects (GET only, no requestBody)", () => {
      const doc = buildOpenApi("https://x") as { paths: Record<string, Record<string, unknown>> };
      expect(Object.keys(doc.paths)).toEqual(["/price"]);
      expect(Object.keys(doc.paths["/price"])).toEqual(["get"]);
    });
  });

  describe("ownership challenge", () => {
    const challenges = { api_abc123: "hk-challenge-token-xyz" };

    it("serves the token byte-exact as text/plain", async () => {
      const res = await request(makeApp({ challenges })).get("/.well-known/hirakumi/api_abc123.txt");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/plain/);
      expect(res.text).toBe("hk-challenge-token-xyz");
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("404s for unknown ids and non-api names", async () => {
      const app = makeApp({ challenges });
      expect((await request(app).get("/.well-known/hirakumi/api_other.txt")).status).toBe(404);
      expect((await request(app).get("/.well-known/hirakumi/__proto__.txt")).status).toBe(404);
      expect((await request(app).get("/.well-known/hirakumi/api_abc123.json")).status).toBe(404);
    });

    it("parses HIRAKUMI_CHALLENGE JSON and ignores bad entries", () => {
      const log = vi.fn();
      expect(parseChallenges('{"api_a1":"t1","bad key":"t2","api_b2":5}', log)).toEqual({ api_a1: "t1" });
      expect(parseChallenges(undefined, log)).toEqual({});
    });

    it("logs and serves nothing when HIRAKUMI_CHALLENGE is not JSON", () => {
      const log = vi.fn();
      expect(parseChallenges("api_a1=t1", log)).toEqual({});
      expect(log).toHaveBeenCalledOnce();
    });
  });
  ```
- [ ] **Step 2: Run, expect FAIL.**
  `pnpm --filter @hirakumi/price-api exec vitest run test/app.meta.test.ts` → FAIL (`doc.paths["/price"]` undefined; challenge parse returns `{}`).
- [ ] **Step 3: Implement.**
  `sellers/price-api/src/openapi.ts`:
  ```ts
  import { SUPPORTED_SYMBOLS } from "./priceSource.js";

  export function buildOpenApi(serverUrl: string): Record<string, unknown> {
    return {
      openapi: "3.1.0",
      info: {
        title: "Hirakumi Demo Price API",
        version: "1.0.0",
        description: "Read-only spot price in US dollars and 24-hour change for a few crypto assets. Data from CoinGecko, cached for 30 seconds.",
      },
      servers: [{ url: serverUrl }],
      paths: {
        "/price": {
          get: {
            operationId: "getPrice",
            summary: "Get the current US dollar price of a crypto asset",
            description: "Returns the latest spot price, the 24-hour percentage change and the time the price was last updated. Read-only, no side effects.",
            parameters: [
              {
                name: "symbol",
                in: "query",
                required: true,
                description: "Ticker symbol of the asset.",
                schema: { type: "string", enum: [...SUPPORTED_SYMBOLS] },
                example: "ADA",
                examples: { ada: { value: "ADA" }, btc: { value: "BTC" }, eth: { value: "ETH" } },
              },
            ],
            responses: {
              "200": {
                description: "Current price",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Price" },
                    examples: {
                      ada: { value: { symbol: "ADA", usd: 0.2695, change24h: 1.25, timestamp: "2026-10-06T08:15:10.000Z" } },
                    },
                  },
                },
              },
              "400": {
                description: "Unknown symbol",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Error" },
                    examples: { unknown: { value: { error: "unknown_symbol", message: "symbol must be one of ADA, BTC, ETH, SOL" } } },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Price: {
            type: "object",
            required: ["symbol", "usd", "change24h", "timestamp"],
            additionalProperties: false,
            properties: {
              symbol: { type: "string", enum: [...SUPPORTED_SYMBOLS], description: "Ticker symbol" },
              usd: { type: "number", minimum: 0, description: "Spot price in US dollars" },
              change24h: { type: "number", description: "Percentage change over the last 24 hours" },
              timestamp: { type: "string", format: "date-time", description: "When the price was last updated (ISO 8601, UTC)" },
            },
          },
          Error: {
            type: "object",
            required: ["error", "message"],
            properties: { error: { type: "string" }, message: { type: "string" } },
          },
        },
      },
    };
  }
  ```
  `sellers/price-api/src/challenge.ts`:
  ```ts
  const API_ID = /^api_[A-Za-z0-9]+$/;

  export function parseChallenges(raw: string | undefined, log: (msg: string) => void): Record<string, string> {
    if (!raw) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log('HIRAKUMI_CHALLENGE is not JSON. Expected {"api_xxx":"token"}; serving no challenge files');
      return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log('HIRAKUMI_CHALLENGE must be a JSON object {"api_xxx":"token"}; serving no challenge files');
      return {};
    }
    const out: Record<string, string> = {};
    for (const [apiId, token] of Object.entries(parsed)) {
      if (API_ID.test(apiId) && typeof token === "string" && token.length > 0) out[apiId] = token;
    }
    return out;
  }
  ```
- [ ] **Step 4: Run all price-api tests, expect PASS.**
  `pnpm --filter @hirakumi/price-api test` → `5 files, 33 passed`. Then `pnpm --filter @hirakumi/price-api typecheck` → no output, exit 0.
- [ ] **Step 5: Commit.**
  ```bash
  git add sellers/price-api
  git commit -m "feat(price-api): OpenAPI 3.1 getPrice spec and /.well-known ownership file" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 6: Vercel entry, deploy and smoke test

**Files:** Create `sellers/price-api/src/index.ts`, `sellers/price-api/src/dev.ts`.

**Interfaces:** `export default app` from `src/index.ts`. Vercel's detected Express entry paths, in order (Vercel docs, checked 6 Oct): `app.*`, `index.*`, `server.*`, `src/app.*`, `src/index.*`, `src/server.*`. That is why the factory is `createApp.ts` and not `app.ts`.

- [ ] **Step 1: Write the entry files.**
  `sellers/price-api/src/index.ts`:
  ```ts
  import { createApp } from "./createApp.js";
  import { createPriceSource } from "./priceSource.js";
  import { modeStoreFromEnv } from "./modeStore.js";
  import { parseChallenges } from "./challenge.js";

  const log = (msg: string, err?: unknown) => console.error(`[price-api] ${msg}`, err ?? "");
  const publicUrl =
    process.env.PUBLIC_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${process.env.PORT ?? 4100}`);

  const app = createApp({
    prices: createPriceSource({
      fetch,
      now: Date.now,
      coingeckoApiKey: process.env.COINGECKO_API_KEY,
      onError: (e) => log("CoinGecko failed; serving fallback price", e),
    }),
    modes: modeStoreFromEnv(process.env),
    now: Date.now,
    adminToken: process.env.ADMIN_TOKEN,
    challenges: parseChallenges(process.env.HIRAKUMI_CHALLENGE, log),
    publicUrl,
    log,
  });

  export default app;
  ```
  `sellers/price-api/src/dev.ts`:
  ```ts
  import app from "./index.js";

  const port = Number(process.env.PORT ?? 4100);
  app.listen(port, () => console.log(`price-api on http://localhost:${port}`));
  ```
- [ ] **Step 2: Local smoke run.**
  ```bash
  ADMIN_TOKEN=local-admin-token-123456 pnpm --filter @hirakumi/price-api start &
  sleep 2
  curl -s 'http://localhost:4100/price?symbol=ADA'          # {"symbol":"ADA","usd":...,"change24h":...,"timestamp":"..."}
  curl -s -XPOST localhost:4100/admin/break -H 'Authorization: Bearer local-admin-token-123456' -H 'content-type: application/json' -d '{"mode":"empty"}'
  curl -s 'http://localhost:4100/price?symbol=ADA'          # {}
  curl -s -XPOST localhost:4100/admin/break -H 'Authorization: Bearer local-admin-token-123456' -H 'content-type: application/json' -d '{"mode":"ok"}'
  kill %1
  ```
- [ ] **Step 3: Create the Vercel project and Redis.**
  ```bash
  cd sellers/price-api && vercel link --project hirakumi-price-api
  ```
  In the Vercel dashboard: Project → Settings → General → Root Directory = `sellers/price-api`. Then Storage → Create Database → **Upstash for Redis** → connect it to `hirakumi-price-api` (Production + Preview).
  **Verify which variable names the integration injected** (unverified: `KV_REST_API_URL/TOKEN` or `UPSTASH_REDIS_REST_URL/TOKEN`; the code accepts both):
  ```bash
  vercel env ls production | grep -E 'KV_REST_API|UPSTASH_REDIS_REST'
  ```
  Add the rest:
  ```bash
  grep '^ADMIN_TOKEN=' ../../.env | cut -d= -f2 | vercel env add ADMIN_TOKEN production
  echo '{}' | vercel env add HIRAKUMI_CHALLENGE production
  ```
  Optional: `vercel env add COINGECKO_API_KEY production`.
- [ ] **Step 4: Deploy and smoke-test production.**
  ```bash
  vercel deploy --prod
  export PRICE_API_URL=https://hirakumi-price-api.vercel.app   # the production URL printed by the deploy
  curl -s $PRICE_API_URL/healthz                     # MUST be {"ok":true,"modeStore":"redis"}; "memory" → stop and fix Redis env
  curl -s "$PRICE_API_URL/price?symbol=ADA" -i | grep -iE 'HTTP/|x-price-source'   # 200, coingecko (fallback is OK but note it)
  curl -s $PRICE_API_URL/openapi.json | jq '.paths["/price"].get.operationId'     # "getPrice"
  for i in 1 2 3 4 5; do curl -s -XPOST $PRICE_API_URL/admin/break -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"mode":"empty"}' >/dev/null; curl -s "$PRICE_API_URL/price?symbol=ADA"; echo; done   # five times {}
  curl -s -XPOST $PRICE_API_URL/admin/break -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"mode":"ok"}'
  ```
  If Vercel does not detect the Express entry (the build log shows no function), fallback: create `sellers/price-api/api/index.ts` containing `export { default } from "../src/index.js";` and `vercel.json` `{ "rewrites": [{ "source": "/(.*)", "destination": "/api" }] }`, then redeploy.
- [ ] **Step 5: Ownership file flow (run with P2 during onboarding).** The seller page shows the token for `<apiId>`. Then:
  ```bash
  vercel env rm HIRAKUMI_CHALLENGE production -y
  echo '{"<apiId from the Ownership screen>":"<token from the Ownership screen>"}' | vercel env add HIRAKUMI_CHALLENGE production
  vercel deploy --prod      # about 30-60s; time-cut in the video
  curl -s $PRICE_API_URL/.well-known/hirakumi/<apiId>.txt
  ```
  Then click Check on the Ownership screen. (The angle-bracket values are runtime data shown on the screen, not plan gaps.) The challenge expires after 30 minutes (spec §5), so redeploy right after generating it.
- [ ] **Step 6: Post `PRICE_API_URL` in team chat** (P1 and P3 need it for manual onboarding by the hour-10 gate) and add it to `.env`.
- [ ] **Step 7: Commit.**
  ```bash
  git add sellers/price-api
  git commit -m "feat(price-api): Vercel entry and local dev server" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 7: buyer scaffold and gateway client (402 parsing, pack choice, call outcomes)

**Files:** Create `agents/buyer/package.json`, `agents/buyer/tsconfig.json`, `agents/buyer/.gitignore`, `agents/buyer/src/gatewayClient.ts`, `agents/buyer/test/fakeGateway.ts`, `agents/buyer/test/gatewayClient.test.ts`.

**Interfaces:**
```ts
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type PackOffer = { packId: string; calls: number; price: string; asset: string; buyUrl: string };
export type CreditsRequired = { error: "credits_required"; packs: PackOffer[]; ruleHash: string; ruleUrl: string };
export class GatewayProtocolError extends Error {}
export class NoAffordablePackError extends Error {}
export function parseCreditsRequired(body: unknown, gatewayUrl: string): CreditsRequired;
export function choosePack(offer: CreditsRequired, maxPackMicros: bigint): PackOffer;
export function formatMicros(m: string | bigint): string;
export type CallOutcome =
  | { kind: "ok"; body: unknown; remaining: number | null; latencyMs: number }
  | { kind: "promise_not_met"; reasons: string[]; remaining: number | null; latencyMs: number }
  | { kind: "upstream_error"; status: number; reasons: string[]; remaining: number | null; latencyMs: number }
  | { kind: "credits_required"; offer: CreditsRequired }
  | { kind: "down"; message: string }
  | { kind: "bad_input"; message: string }
  | { kind: "token_pending" }
  | { kind: "invalid_token"; message: string }
  | { kind: "unexpected"; status: number; text: string };
export function callOperation(f: FetchLike, a: { gatewayUrl: string; apiId: string; opId: string; query: Record<string, string>; token?: string }): Promise<CallOutcome>;
export function safeJson(text: string): unknown;
export function messageOf(json: unknown, text: string): string;
```

- [ ] **Step 1: Scaffold.**
  ```bash
  mkdir -p agents/buyer/src/cli agents/buyer/test && cd agents/buyer
  cat > package.json <<'EOF'
  {
    "name": "@hirakumi/buyer",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "engines": { "node": ">=22" },
    "scripts": {
      "pack": "tsx src/cli/pack.ts",
      "escrow": "tsx src/cli/escrow.ts",
      "test": "vitest run",
      "typecheck": "tsc --noEmit"
    }
  }
  EOF
  cat > tsconfig.json <<'EOF'
  {
    "compilerOptions": {
      "target": "ES2023",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "noEmit": true,
      "types": ["node"]
    },
    "include": ["src", "test"]
  }
  EOF
  printf '.tokens.json\n.tokens.json.tmp\n' > .gitignore
  pnpm add -E @x402/fetch@2.26.0 @x402/cardano@2.26.0 @x402/core@2.26.0 dotenv
  pnpm add @hirakumi/core@workspace:* @hirakumi/masumi@workspace:*
  pnpm add -DE @types/node@22 tsx typescript vitest
  grep '"@x402' package.json   # every line must read "2.26.0" with no ^ or ~
  ```
- [ ] **Step 2: Write the shared fake gateway** `agents/buyer/test/fakeGateway.ts`:
  ```ts
  import { USDM_PREPROD_ASSET } from "@x402/cardano";
  import type { FetchLike } from "../src/gatewayClient.js";

  export const GW = "https://gw.test";
  export const API = "api_demo";
  export const TOKEN = "hk_test";
  export const MASUMI_UNIT = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
  export type Mode = "pass" | "fail" | "down" | "pending" | "upstream_502";

  export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  export function fakeGateway(o: {
    modes?: Mode[];
    credits?: number;
    asset?: string;
    price?: string;
    chargeOnFail?: boolean;
    remainingHeaderOnRefusal?: boolean;
    downBeforePay?: boolean;
  } = {}) {
    const state = { remaining: o.credits ?? 5, urls: [] as string[], modes: [...(o.modes ?? [])] };
    const fetch: FetchLike = async (url, init) => {
      state.urls.push(url);
      const auth = new Headers(init?.headers).get("authorization");
      if (!auth) {
        if (o.downBeforePay) return json(503, { status: "unavailable", message: "API is Down" });
        return json(402, {
          error: "credits_required",
          packs: [{ packId: "pk_demo", calls: o.credits ?? 5, price: o.price ?? "2000000", asset: o.asset ?? USDM_PREPROD_ASSET, buyUrl: `/a/${API}/packs/pk_demo` }],
          ruleHash: "sha256:abc",
          ruleUrl: "/r/sha256:abc",
        });
      }
      if (auth !== `Bearer ${TOKEN}`) return json(401, { error: "invalid_token", message: "unknown token" });
      const mode = state.modes.shift() ?? "pass";
      if (mode === "pending") return json(401, { error: "token_pending" });
      if (mode === "down") return json(503, { status: "unavailable", message: "API is Down" });
      if (mode === "fail" || mode === "upstream_502") {
        if (o.chargeOnFail) state.remaining--;
        const h: Record<string, string> = o.remainingHeaderOnRefusal ? { "X-Credits-Remaining": String(state.remaining) } : {};
        return mode === "fail"
          ? json(422, { error: "promise_not_met", reasons: ["/usd is required"] }, h)
          : json(502, { error: "upstream_error", reasons: ["upstream answered 500"] }, h);
      }
      if (state.remaining <= 0) return fetch(url, { ...init, headers: {} });
      state.remaining--;
      return json(200, { symbol: "ADA", usd: 0.27, change24h: 1.2, timestamp: "2026-10-06T08:00:00.000Z" }, { "X-Credits-Remaining": String(state.remaining) });
    };
    return { fetch, state };
  }
  ```
- [ ] **Step 3: Write the failing test** `agents/buyer/test/gatewayClient.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { USDM_PREPROD_ASSET } from "@x402/cardano";
  import { callOperation, choosePack, formatMicros, parseCreditsRequired, NoAffordablePackError, GatewayProtocolError } from "../src/gatewayClient.js";
  import { fakeGateway, json, GW, API, TOKEN, MASUMI_UNIT } from "./fakeGateway.js";

  const call = (f: Parameters<typeof callOperation>[0], token?: string) =>
    callOperation(f, { gatewayUrl: GW, apiId: API, opId: "getPrice", query: { symbol: "ADA" }, token });

  describe("gatewayClient", () => {
    it("parses credits_required and makes URLs absolute", async () => {
      const r = await call(fakeGateway().fetch);
      expect(r.kind).toBe("credits_required");
      if (r.kind !== "credits_required") return;
      expect(r.offer.packs[0].buyUrl).toBe(`${GW}/a/${API}/packs/pk_demo`);
      expect(r.offer.ruleUrl).toBe(`${GW}/r/sha256:abc`);
    });

    it("builds the op URL with the query string and bearer token", async () => {
      const gw = fakeGateway();
      await call(gw.fetch, TOKEN);
      expect(gw.state.urls[0]).toBe(`${GW}/a/${API}/x/getPrice?symbol=ADA`);
    });

    it("classifies 200 with X-Credits-Remaining", async () => {
      const r = await call(fakeGateway({ credits: 5 }).fetch, TOKEN);
      expect(r).toMatchObject({ kind: "ok", remaining: 4 });
    });

    it("classifies 422 with reasons and an optional remaining header", async () => {
      const r = await call(fakeGateway({ modes: ["fail"], remainingHeaderOnRefusal: true }).fetch, TOKEN);
      expect(r).toMatchObject({ kind: "promise_not_met", reasons: ["/usd is required"], remaining: 5 });
      const r2 = await call(fakeGateway({ modes: ["fail"] }).fetch, TOKEN);
      expect(r2).toMatchObject({ kind: "promise_not_met", remaining: null });
    });

    it("classifies 503, 401 pending, 401 invalid, 502", async () => {
      expect((await call(fakeGateway({ modes: ["down"] }).fetch, TOKEN)).kind).toBe("down");
      expect((await call(fakeGateway({ modes: ["pending"] }).fetch, TOKEN)).kind).toBe("token_pending");
      expect((await call(fakeGateway().fetch, "hk_wrong")).kind).toBe("invalid_token");
      expect((await call(fakeGateway({ modes: ["upstream_502"] }).fetch, TOKEN))).toMatchObject({ kind: "upstream_error", status: 502 });
    });

    it("classifies 400 as bad input", async () => {
      const r = await call(async () => json(400, { error: "invalid_input", message: "symbol must be one of ADA" }));
      expect(r).toEqual({ kind: "bad_input", message: "symbol must be one of ADA" });
    });

    it("rejects a 402 that is not credits_required", () => {
      expect(() => parseCreditsRequired({ x402Version: 2, accepts: [] }, GW)).toThrow(GatewayProtocolError);
    });

    it("choosePack picks the cheapest per call within the cap", () => {
      const offer = parseCreditsRequired({
        error: "credits_required", ruleHash: "h", ruleUrl: "/r/h",
        packs: [
          { packId: "small", calls: 10, price: "1000000", asset: USDM_PREPROD_ASSET, buyUrl: "/a/x/packs/small" },
          { packId: "big", calls: 100, price: "2000000", asset: USDM_PREPROD_ASSET, buyUrl: "/a/x/packs/big" },
          { packId: "huge", calls: 1000, price: "9000000", asset: USDM_PREPROD_ASSET, buyUrl: "/a/x/packs/huge" },
        ],
      }, GW);
      expect(choosePack(offer, 5_000_000n).packId).toBe("big");
    });

    it("choosePack refuses a pack priced in the escrow unit (two-token mix-up)", () => {
      const offer = parseCreditsRequired({
        error: "credits_required", ruleHash: "h", ruleUrl: "/r/h",
        packs: [{ packId: "pk", calls: 100, price: "2000000", asset: MASUMI_UNIT, buyUrl: "/a/x/packs/pk" }],
      }, GW);
      expect(() => choosePack(offer, 5_000_000n)).toThrow(NoAffordablePackError);
    });

    it("choosePack refuses packs above the spend cap", () => {
      const offer = parseCreditsRequired({
        error: "credits_required", ruleHash: "h", ruleUrl: "/r/h",
        packs: [{ packId: "pk", calls: 100, price: "6000000", asset: USDM_PREPROD_ASSET, buyUrl: "/a/x/packs/pk" }],
      }, GW);
      expect(() => choosePack(offer, 5_000_000n)).toThrow(/price ≤ 5000000/);
    });

    it("formats micros as tUSDM", () => {
      expect(formatMicros("2000000")).toBe("2");
      expect(formatMicros(1_250_000n)).toBe("1.25");
      expect(formatMicros("100")).toBe("0.0001");
    });
  });
  ```
- [ ] **Step 4: Run, expect FAIL.**
  `pnpm --filter @hirakumi/buyer exec vitest run test/gatewayClient.test.ts` → FAIL, cannot load `../src/gatewayClient.js`.
- [ ] **Step 5: Implement** `agents/buyer/src/gatewayClient.ts`:
  ```ts
  import { USDM_PREPROD_ASSET } from "@x402/cardano";

  export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
  export type PackOffer = { packId: string; calls: number; price: string; asset: string; buyUrl: string };
  export type CreditsRequired = { error: "credits_required"; packs: PackOffer[]; ruleHash: string; ruleUrl: string };
  export type CallOutcome =
    | { kind: "ok"; body: unknown; remaining: number | null; latencyMs: number }
    | { kind: "promise_not_met"; reasons: string[]; remaining: number | null; latencyMs: number }
    | { kind: "upstream_error"; status: number; reasons: string[]; remaining: number | null; latencyMs: number }
    | { kind: "credits_required"; offer: CreditsRequired }
    | { kind: "down"; message: string }
    | { kind: "bad_input"; message: string }
    | { kind: "token_pending" }
    | { kind: "invalid_token"; message: string }
    | { kind: "unexpected"; status: number; text: string };

  export class GatewayProtocolError extends Error {}
  export class NoAffordablePackError extends Error {}

  export function safeJson(text: string): unknown {
    try { return JSON.parse(text); } catch { return undefined; }
  }

  export function messageOf(json: unknown, text: string): string {
    const j = json as { message?: unknown; error?: unknown } | undefined;
    if (typeof j?.message === "string") return j.message;
    if (typeof j?.error === "string") return j.error;
    return text.slice(0, 300);
  }

  function reasonsOf(json: unknown): string[] {
    const r = (json as { reasons?: unknown } | undefined)?.reasons;
    return Array.isArray(r) ? r.map(String) : [];
  }

  function readRemaining(res: Response): number | null {
    const h = res.headers.get("x-credits-remaining");
    if (h === null || !/^\d+$/.test(h)) return null;
    return Number(h);
  }

  export function parseCreditsRequired(body: unknown, gatewayUrl: string): CreditsRequired {
    const b = body as Partial<CreditsRequired> | undefined;
    if (!b || b.error !== "credits_required" || !Array.isArray(b.packs) || typeof b.ruleHash !== "string" || typeof b.ruleUrl !== "string") {
      throw new GatewayProtocolError(`402 body is not credits_required: ${JSON.stringify(body)}`);
    }
    const packs = b.packs.map((p: Partial<PackOffer>) => {
      if (typeof p?.packId !== "string" || !Number.isInteger(p.calls) || typeof p.price !== "string" || !/^\d+$/.test(p.price) ||
          typeof p.asset !== "string" || typeof p.buyUrl !== "string") {
        throw new GatewayProtocolError(`bad pack offer: ${JSON.stringify(p)}`);
      }
      return { packId: p.packId, calls: p.calls as number, price: p.price, asset: p.asset, buyUrl: new URL(p.buyUrl, gatewayUrl).toString() };
    });
    return { error: "credits_required", packs, ruleHash: b.ruleHash, ruleUrl: new URL(b.ruleUrl, gatewayUrl).toString() };
  }

  export function choosePack(offer: CreditsRequired, maxPackMicros: bigint): PackOffer {
    const usable = offer.packs.filter((p) => p.asset === USDM_PREPROD_ASSET && p.calls > 0 && BigInt(p.price) <= maxPackMicros);
    if (usable.length === 0) {
      throw new NoAffordablePackError(
        `No payable pack: need asset ${USDM_PREPROD_ASSET} and price ≤ ${maxPackMicros} micros; offered ` +
          offer.packs.map((p) => `${p.packId} ${p.price} ${p.asset}`).join("; "),
      );
    }
    return usable.reduce((best, p) => (BigInt(p.price) * BigInt(best.calls) < BigInt(best.price) * BigInt(p.calls) ? p : best));
  }

  export function formatMicros(micros: string | bigint): string {
    const v = BigInt(micros);
    const whole = v / 1_000_000n;
    const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  }

  export async function callOperation(
    fetchImpl: FetchLike,
    a: { gatewayUrl: string; apiId: string; opId: string; query: Record<string, string>; token?: string },
  ): Promise<CallOutcome> {
    const url = new URL(`/a/${encodeURIComponent(a.apiId)}/x/${encodeURIComponent(a.opId)}`, a.gatewayUrl);
    for (const [k, v] of Object.entries(a.query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json" };
    if (a.token) headers.authorization = `Bearer ${a.token}`;
    const started = performance.now();
    const res = await fetchImpl(url.toString(), { method: "GET", headers });
    const latencyMs = Math.round(performance.now() - started);
    const text = await res.text();
    const body = safeJson(text);
    const remaining = readRemaining(res);
    switch (res.status) {
      case 200: return { kind: "ok", body: body ?? text, remaining, latencyMs };
      case 422: return { kind: "promise_not_met", reasons: reasonsOf(body), remaining, latencyMs };
      case 502:
      case 504: return { kind: "upstream_error", status: res.status, reasons: reasonsOf(body), remaining, latencyMs };
      case 402: return { kind: "credits_required", offer: parseCreditsRequired(body, a.gatewayUrl) };
      case 503: return { kind: "down", message: messageOf(body, text) };
      case 400: return { kind: "bad_input", message: messageOf(body, text) };
      case 401:
        return (body as { error?: unknown } | undefined)?.error === "token_pending"
          ? { kind: "token_pending" }
          : { kind: "invalid_token", message: messageOf(body, text) };
      default: return { kind: "unexpected", status: res.status, text: text.slice(0, 500) };
    }
  }
  ```
- [ ] **Step 6: Run, expect PASS.** Same command → `11 passed`.
- [ ] **Step 7: Commit.**
  ```bash
  git add agents/buyer pnpm-lock.yaml
  git commit -m "feat(buyer): gateway client, credits_required parsing and pack choice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 8: x402 pay client (spend controls for USDM, serial payments)

**Files:** Create `agents/buyer/src/payClient.ts`, `agents/buyer/test/payClient.test.ts`.

**Interfaces:**
```ts
export function spendControlsFor(maxPackMicros: bigint): SpendControls;   // from "@x402/core/client"
export class SerialPayer { run<T>(task: () => Promise<T>): Promise<T> }
export type PackPurchase = { token: string; credits: number; apiId: string; txHash: string | null };
export class PackPurchaseError extends Error { status: number; body: string }
export function createPackPayer(cfg: { mnemonic: string; blockfrostProjectId: string; blockfrostBaseUrl: string; maxPackMicros: bigint }):
  { address: string; buyPack(buyUrl: string): Promise<PackPurchase> };
```
Verified against installed `2.26.0`: `x402Client.setSpendControls(controls: SpendControls | false)`. `SpendControlAsset = { network; asset; maxAmountPerPayment?: string /* integer atomic */ }`. Default `maxAmountPerPayment` is `"$1"` for default assets, and `USDM_PREPROD_ASSET` is a default asset for `cardano:preprod`. `toClientCardanoSigner({ mnemonic, network, provider: { blockfrost: { baseUrl, projectId } } })`. `wrapFetchWithPayment(fetch, client)`. `findDefaultAsset` is exported by `@x402/cardano`.

- [ ] **Step 1: Write the failing test** `agents/buyer/test/payClient.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { x402Client, type PaymentRequired, type SchemeNetworkClient } from "@x402/fetch";
  import { USDM_PREPROD_ASSET, findDefaultAsset } from "@x402/cardano";
  import { spendControlsFor, SerialPayer } from "../src/payClient.js";

  // A scheme that never signs: it only reports the cap the client resolved.
  function fakeScheme(): SchemeNetworkClient {
    return {
      scheme: "exact",
      findDefaultAsset,
      async createPaymentPayload(v, _req, ctx) {
        return { x402Version: v, payload: { cap: ctx?.maxAmountPerPayment ?? null } };
      },
    };
  }
  const required = (amount: string, asset = USDM_PREPROD_ASSET): PaymentRequired => ({
    x402Version: 2,
    resource: { url: "https://gw.test/a/api_demo/packs/pk_demo" },
    accepts: [{ scheme: "exact", network: "cardano:preprod", asset, amount, payTo: "addr_test1qz0000", maxTimeoutSeconds: 600, extra: {} }],
  });
  function clientWith(controls?: ReturnType<typeof spendControlsFor>) {
    const c = new x402Client();
    if (controls) c.setSpendControls(controls);
    c.register("cardano:*", fakeScheme());
    return c;
  }

  describe("spend controls", () => {
    it("the default controls refuse a 2 tUSDM pack (the $1 trap)", async () => {
      await expect(clientWith().createPaymentPayload(required("2000000"))).rejects.toThrow(/\$1/);
    });

    it("allows a 2 tUSDM pack and refuses 6 tUSDM under a 5 tUSDM cap", async () => {
      const ok = await clientWith(spendControlsFor(5_000_000n)).createPaymentPayload(required("2000000"));
      expect(ok.payload).toEqual({ cap: "5000000" });
      await expect(clientWith(spendControlsFor(5_000_000n)).createPaymentPayload(required("6000000"))).rejects.toThrow(/maxAmountPerPayment/);
    });

    it("never pays in lovelace", async () => {
      await expect(clientWith(spendControlsFor(5_000_000n)).createPaymentPayload(required("2000000", "lovelace"))).rejects.toThrow(/spendControls/);
    });

    it("rejects a non-positive cap", () => {
      expect(() => spendControlsFor(0n)).toThrow();
    });
  });

  describe("SerialPayer", () => {
    it("never runs two payments at once", async () => {
      const payer = new SerialPayer();
      let inFlight = 0;
      let maxInFlight = 0;
      const task = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return "done";
      };
      await Promise.all([payer.run(task), payer.run(task), payer.run(task)]);
      expect(maxInFlight).toBe(1);
    });

    it("keeps going after a failed payment", async () => {
      const payer = new SerialPayer();
      await expect(payer.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
      await expect(payer.run(async () => 42)).resolves.toBe(42);
    });
  });
  ```
- [ ] **Step 2: Run, expect FAIL.**
  `pnpm --filter @hirakumi/buyer exec vitest run test/payClient.test.ts` → FAIL, cannot load `../src/payClient.js`.
- [ ] **Step 3: Implement** `agents/buyer/src/payClient.ts`:
  ```ts
  import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
  import { toClientCardanoSigner, USDM_PREPROD_ASSET } from "@x402/cardano";
  import { ExactCardanoScheme } from "@x402/cardano/exact/client";
  import type { SpendControls } from "@x402/core/client";

  export function spendControlsFor(maxPackMicros: bigint): SpendControls {
    if (maxPackMicros <= 0n) throw new Error("maxPackMicros must be positive");
    // USDM is a default asset, so without this entry the client applies a $1 cap and refuses a 2 tUSDM pack.
    // Listing only USDM also means lovelace (not a default asset) is never paid.
    return { allowedAssets: [{ network: "cardano:preprod", asset: USDM_PREPROD_ASSET, maxAmountPerPayment: maxPackMicros.toString() }] };
  }

  /** One wallet, one payment at a time: the Cardano signer uses the first UTxO as the nonce. */
  export class SerialPayer {
    private tail: Promise<unknown> = Promise.resolve();
    run<T>(task: () => Promise<T>): Promise<T> {
      const next = this.tail.then(task, task);
      this.tail = next.catch(() => undefined);
      return next;
    }
  }

  export type PackPurchase = { token: string; credits: number; apiId: string; txHash: string | null };

  export class PackPurchaseError extends Error {
    constructor(readonly status: number, readonly body: string) {
      super(`Pack purchase failed: HTTP ${status} ${body.slice(0, 300)}`);
    }
  }

  export function createPackPayer(cfg: { mnemonic: string; blockfrostProjectId: string; blockfrostBaseUrl: string; maxPackMicros: bigint }) {
    const client = new x402Client().setSpendControls(spendControlsFor(cfg.maxPackMicros));
    const signer = toClientCardanoSigner({
      mnemonic: cfg.mnemonic,
      network: "cardano:preprod",
      provider: { blockfrost: { baseUrl: cfg.blockfrostBaseUrl, projectId: cfg.blockfrostProjectId } },
    });
    const address = signer.getAddress();
    if (!address.startsWith("addr_test1")) throw new Error(`Buyer wallet ${address} is not a preprod address`);
    client.register("cardano:*", new ExactCardanoScheme(signer));
    const payFetch = wrapFetchWithPayment(fetch, client);
    const http = new x402HTTPClient(client);
    const serial = new SerialPayer();

    return {
      address,
      buyPack(buyUrl: string): Promise<PackPurchase> {
        return serial.run(async () => {
          const res = await payFetch(buyUrl, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: "{}",
          });
          const text = await res.text();
          if (!res.ok) throw new PackPurchaseError(res.status, text);
          const body = JSON.parse(text) as { token?: unknown; credits?: unknown; apiId?: unknown };
          if (typeof body.token !== "string" || typeof body.credits !== "number" || typeof body.apiId !== "string") {
            throw new PackPurchaseError(res.status, text);
          }
          let txHash: string | null = null;
          try {
            txHash = http.getPaymentSettleResponse((name) => res.headers.get(name))?.transaction ?? null;
          } catch {
            txHash = null;
          }
          return { token: body.token, credits: body.credits, apiId: body.apiId, txHash };
        });
      },
    };
  }
  ```
- [ ] **Step 4: Run, expect PASS.** Same command → `6 passed`. Also run `pnpm --filter @hirakumi/buyer typecheck`. If `findDefaultAsset`'s generic type is not assignable to `SchemeNetworkClient["findDefaultAsset"]`, wrap it: `findDefaultAsset: (asset, network) => findDefaultAsset(asset, network)`.
- [ ] **Step 5: Commit.**
  ```bash
  git add agents/buyer
  git commit -m "feat(buyer): x402 pack payer with USDM spend cap and serial payments" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 9: token store

**Files:** Create `agents/buyer/src/tokenStore.ts`, `agents/buyer/test/tokenStore.test.ts`.

**Interfaces:**
```ts
export type StoredToken = { token: string; packId: string; credits: number; txHash: string | null; boughtAt: string };
export class TokenStore { constructor(path: string); get(apiId: string): StoredToken | undefined; put(apiId: string, t: StoredToken): void; delete(apiId: string): void }
```

- [ ] **Step 1: Write the failing test** `agents/buyer/test/tokenStore.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { mkdtempSync, statSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { TokenStore } from "../src/tokenStore.js";

  const rec = { token: "hk_x", packId: "pk_1", credits: 100, txHash: null, boughtAt: "2026-10-06T08:00:00.000Z" };

  describe("TokenStore", () => {
    it("returns undefined when the file does not exist", () => {
      const s = new TokenStore(join(mkdtempSync(join(tmpdir(), "hk-")), "t.json"));
      expect(s.get("api_1")).toBeUndefined();
    });

    it("round-trips and keeps the file private (0600)", () => {
      const path = join(mkdtempSync(join(tmpdir(), "hk-")), "nested", "t.json");
      const s = new TokenStore(path);
      s.put("api_1", rec);
      expect(new TokenStore(path).get("api_1")).toEqual(rec);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it("deletes one api without touching others", () => {
      const s = new TokenStore(join(mkdtempSync(join(tmpdir(), "hk-")), "t.json"));
      s.put("api_1", rec);
      s.put("api_2", { ...rec, token: "hk_y" });
      s.delete("api_1");
      expect(s.get("api_1")).toBeUndefined();
      expect(s.get("api_2")?.token).toBe("hk_y");
    });
  });
  ```
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @hirakumi/buyer exec vitest run test/tokenStore.test.ts` → cannot load module.
- [ ] **Step 3: Implement** `agents/buyer/src/tokenStore.ts`:
  ```ts
  import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
  import { dirname } from "node:path";

  export type StoredToken = { token: string; packId: string; credits: number; txHash: string | null; boughtAt: string };

  export class TokenStore {
    constructor(private readonly path: string) {}

    private readAll(): Record<string, StoredToken> {
      try {
        return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, StoredToken>;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw e;
      }
    }

    private writeAll(all: Record<string, StoredToken>): void {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    }

    get(apiId: string): StoredToken | undefined {
      return this.readAll()[apiId];
    }

    put(apiId: string, t: StoredToken): void {
      const all = this.readAll();
      all[apiId] = t;
      this.writeAll(all);
    }

    delete(apiId: string): void {
      const all = this.readAll();
      delete all[apiId];
      this.writeAll(all);
    }
  }
  ```
- [ ] **Step 4: Run, expect PASS** → `3 passed`.
- [ ] **Step 5: Commit.**
  ```bash
  git add agents/buyer
  git commit -m "feat(buyer): private credit-token store" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 10: pack-buyer flow and CLI

**Files:** Create `agents/buyer/src/packBuyer.ts`, `agents/buyer/src/env.ts`, `agents/buyer/src/cli/pack.ts`, `agents/buyer/test/packBuyer.test.ts`.

**Interfaces:**
```ts
export type PackDemoDeps = { fetch: FetchLike; buyPack: (buyUrl: string) => Promise<PackPurchase>; tokens: TokenStore;
  log: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number };
export type PackDemoOptions = { gatewayUrl: string; apiId: string; opId: string; query: Record<string, string>; calls: number;
  intervalMs: number; maxPackMicros: bigint; pendingTimeoutMs: number; pendingPollMs: number };
export type PackDemoSummary = { bought: boolean; txHash: string | null; passed: number; notMet: number; upstreamErrors: number;
  down: number; lastRemaining: number | null; creditAccountingOk: boolean };
export function runPackDemo(deps: PackDemoDeps, o: PackDemoOptions): Promise<PackDemoSummary>;
```
CLI: `pnpm --filter @hirakumi/buyer pack -- --api <apiId> [--op getPrice] [--symbol ADA] [--calls 20] [--interval 2000] [--fresh]`.

- [ ] **Step 1: Write the failing test** `agents/buyer/test/packBuyer.test.ts`:
  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { mkdtempSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { runPackDemo, type PackDemoOptions } from "../src/packBuyer.js";
  import { TokenStore } from "../src/tokenStore.js";
  import { NoAffordablePackError } from "../src/gatewayClient.js";
  import { fakeGateway, GW, API, TOKEN, MASUMI_UNIT } from "./fakeGateway.js";

  const opts = (over: Partial<PackDemoOptions> = {}): PackDemoOptions => ({
    gatewayUrl: GW, apiId: API, opId: "getPrice", query: { symbol: "ADA" }, calls: 2, intervalMs: 0,
    maxPackMicros: 5_000_000n, pendingTimeoutMs: 60_000, pendingPollMs: 3_000, ...over,
  });
  function deps(gw: ReturnType<typeof fakeGateway>, tokens = new TokenStore(join(mkdtempSync(join(tmpdir(), "hk-")), "t.json"))) {
    const lines: string[] = [];
    let now = 0;
    return {
      lines,
      tokens,
      buyPack: vi.fn(async (_url: string) => ({ token: TOKEN, credits: 5, apiId: API, txHash: "ab".repeat(32) })),
      make() {
        return {
          fetch: gw.fetch,
          buyPack: this.buyPack,
          tokens,
          log: (l: string) => lines.push(l),
          sleep: vi.fn(async (ms: number) => { now += ms; }),
          now: () => now,
        };
      },
    };
  }

  describe("runPackDemo", () => {
    it("buys once on 402, stores the token, then calls with credits", async () => {
      const gw = fakeGateway({ modes: ["pass", "pass"] });
      const h = deps(gw);
      const s = await runPackDemo(h.make(), opts());
      expect(h.buyPack).toHaveBeenCalledOnce();
      expect(s).toMatchObject({ bought: true, passed: 2, lastRemaining: 3, creditAccountingOk: true });
      expect(h.tokens.get(API)?.token).toBe(TOKEN);
      expect(h.lines.join("\n")).toContain(`https://preprod.cardanoscan.io/transaction/${"ab".repeat(32)}`);
    });

    it("op calls never hit /packs and buyPack only receives the buyUrl", async () => {
      const gw = fakeGateway({ modes: ["pass"] });
      const h = deps(gw);
      await runPackDemo(h.make(), opts({ calls: 1 }));
      expect(gw.state.urls.every((u) => u.includes("/x/getPrice"))).toBe(true);
      expect(h.buyPack.mock.calls.map((c) => c[0])).toEqual([`${GW}/a/${API}/packs/pk_demo`]);
    });

    it("422 uses no credit (gateway sends X-Credits-Remaining on refusals)", async () => {
      const gw = fakeGateway({ modes: ["pass", "fail", "fail", "pass"], remainingHeaderOnRefusal: true });
      const h = deps(gw);
      const s = await runPackDemo(h.make(), opts({ calls: 4 }));
      expect(s).toMatchObject({ passed: 2, notMet: 2, lastRemaining: 3, creditAccountingOk: true });
      const out = h.lines.join("\n");
      expect(out).toContain("422 promise not met: /usd is required");
      expect(out).toContain("credits unchanged: 4");
    });

    it("422 without the header is confirmed on the next 200", async () => {
      const gw = fakeGateway({ modes: ["pass", "fail", "pass"] });
      const s = await runPackDemo(deps(gw).make(), opts({ calls: 3 }));
      expect(s).toMatchObject({ notMet: 1, lastRemaining: 3, creditAccountingOk: true });
    });

    it("detects a gateway that charges on 422", async () => {
      const gw = fakeGateway({ modes: ["pass", "fail", "pass"], chargeOnFail: true });
      const h = deps(gw);
      const s = await runPackDemo(h.make(), opts({ calls: 3 }));
      expect(s.creditAccountingOk).toBe(false);
      expect(h.lines.join("\n")).toContain("CREDIT MISMATCH");
    });

    it("503 Down before paying: no purchase", async () => {
      const gw = fakeGateway({ downBeforePay: true });
      const h = deps(gw);
      const s = await runPackDemo(h.make(), opts());
      expect(h.buyPack).not.toHaveBeenCalled();
      expect(s.down).toBe(1);
    });

    it("waits while the token is pending, then succeeds", async () => {
      const gw = fakeGateway({ modes: ["pending", "pending", "pass"] });
      const h = deps(gw);
      const d = h.make();
      const s = await runPackDemo(d, opts({ calls: 1 }));
      expect(s.passed).toBe(1);
      expect(d.sleep).toHaveBeenCalledWith(3_000);
    });

    it("gives up if the token stays pending past the timeout", async () => {
      const gw = fakeGateway({ modes: Array(50).fill("pending") });
      await expect(runPackDemo(deps(gw).make(), opts({ calls: 1, pendingTimeoutMs: 9_000 }))).rejects.toThrow(/still pending/);
    });

    it("refuses a pack priced in the escrow unit and never pays", async () => {
      const gw = fakeGateway({ asset: MASUMI_UNIT });
      const h = deps(gw);
      await expect(runPackDemo(h.make(), opts())).rejects.toThrow(NoAffordablePackError);
      expect(h.buyPack).not.toHaveBeenCalled();
    });

    it("reuses a stored token without an unpaid request or a purchase", async () => {
      const gw = fakeGateway({ modes: ["pass"] });
      const h = deps(gw);
      h.tokens.put(API, { token: TOKEN, packId: "pk_demo", credits: 5, txHash: null, boughtAt: "x" });
      const s = await runPackDemo(h.make(), opts({ calls: 1 }));
      expect(h.buyPack).not.toHaveBeenCalled();
      expect(s.passed).toBe(1);
      expect(gw.state.urls).toHaveLength(1);
    });
  });
  ```
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @hirakumi/buyer exec vitest run test/packBuyer.test.ts` → cannot load `../src/packBuyer.js`.
- [ ] **Step 3: Implement** `agents/buyer/src/packBuyer.ts`:
  ```ts
  import { callOperation, choosePack, formatMicros, type CallOutcome, type CreditsRequired, type FetchLike } from "./gatewayClient.js";
  import type { PackPurchase } from "./payClient.js";
  import type { TokenStore } from "./tokenStore.js";

  export type PackDemoDeps = {
    fetch: FetchLike;
    buyPack: (buyUrl: string) => Promise<PackPurchase>;
    tokens: TokenStore;
    log: (line: string) => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  };
  export type PackDemoOptions = {
    gatewayUrl: string; apiId: string; opId: string; query: Record<string, string>; calls: number;
    intervalMs: number; maxPackMicros: bigint; pendingTimeoutMs: number; pendingPollMs: number;
  };
  export type PackDemoSummary = {
    bought: boolean; txHash: string | null; passed: number; notMet: number; upstreamErrors: number;
    down: number; lastRemaining: number | null; creditAccountingOk: boolean;
  };

  function describe(o: CallOutcome): string {
    return o.kind === "unexpected" ? `HTTP ${o.status}` : o.kind;
  }

  export async function runPackDemo(deps: PackDemoDeps, o: PackDemoOptions): Promise<PackDemoSummary> {
    const s: PackDemoSummary = { bought: false, txHash: null, passed: 0, notMet: 0, upstreamErrors: 0, down: 0, lastRemaining: null, creditAccountingOk: true };
    const target = { gatewayUrl: o.gatewayUrl, apiId: o.apiId, opId: o.opId, query: o.query };

    const buy = async (offer: CreditsRequired): Promise<string> => {
      const pack = choosePack(offer, o.maxPackMicros);
      deps.log(`402 credits_required. Promise ${offer.ruleHash} (${offer.ruleUrl})`);
      deps.log(`Buying pack ${pack.packId}: ${pack.calls} calls for ${formatMicros(pack.price)} tUSDM, one Cardano preprod payment (about 20-60s)...`);
      const started = deps.now();
      const p = await deps.buyPack(pack.buyUrl);
      deps.log(
        `Paid in ${((deps.now() - started) / 1000).toFixed(1)}s: ${p.credits} credits.` +
          (p.txHash ? ` Tx https://preprod.cardanoscan.io/transaction/${p.txHash}` : " (no receipt header)"),
      );
      deps.tokens.put(o.apiId, { token: p.token, packId: pack.packId, credits: p.credits, txHash: p.txHash, boughtAt: new Date(deps.now()).toISOString() });
      s.bought = true;
      s.txHash = p.txHash;
      s.lastRemaining = p.credits;
      return p.token;
    };

    const checkCredits = (remaining: number | null, charged: boolean) => {
      if (remaining === null) {
        if (!charged) deps.log("   (no X-Credits-Remaining on this refusal; the next 200 confirms nothing was charged)");
        return;
      }
      if (s.lastRemaining !== null) {
        const expected = charged ? s.lastRemaining - 1 : s.lastRemaining;
        if (remaining !== expected) {
          s.creditAccountingOk = false;
          deps.log(`   CREDIT MISMATCH: expected ${expected}, gateway says ${remaining}`);
        } else if (!charged) {
          deps.log(`   credits unchanged: ${remaining}`);
        }
      }
      s.lastRemaining = remaining;
    };

    let token = deps.tokens.get(o.apiId)?.token;
    if (token) {
      deps.log(`Using the stored credit token for ${o.apiId}`);
    } else {
      const first = await callOperation(deps.fetch, target);
      if (first.kind === "down") {
        s.down++;
        deps.log(`503 Down: ${first.message}. No payment made.`);
        return s;
      }
      if (first.kind !== "credits_required") throw new Error(`Expected 402 credits_required, got ${describe(first)}`);
      token = await buy(first.offer);
    }

    let pendingSince: number | null = null;
    let i = 1;
    while (i <= o.calls) {
      const r = await callOperation(deps.fetch, { ...target, token });
      if (r.kind === "token_pending") {
        pendingSince ??= deps.now();
        if (deps.now() - pendingSince >= o.pendingTimeoutMs) {
          throw new Error(`Credit token still pending after ${o.pendingTimeoutMs}ms: the payment has not settled`);
        }
        deps.log("Token pending: waiting for settlement...");
        await deps.sleep(o.pendingPollMs);
        continue;
      }
      pendingSince = null;
      let stop = false;
      switch (r.kind) {
        case "ok":
          s.passed++;
          deps.log(`#${i} 200 in ${r.latencyMs}ms  credits left: ${r.remaining ?? "?"}  ${JSON.stringify(r.body)}`);
          checkCredits(r.remaining, true);
          break;
        case "promise_not_met":
          s.notMet++;
          deps.log(`#${i} 422 promise not met: ${r.reasons.join("; ")}`);
          checkCredits(r.remaining, false);
          break;
        case "upstream_error":
          s.upstreamErrors++;
          deps.log(`#${i} ${r.status} upstream error: ${r.reasons.join("; ")}`);
          checkCredits(r.remaining, false);
          break;
        case "down":
          s.down++;
          deps.log(`#${i} 503 Down: ${r.message}. No credit used.`);
          break;
        case "credits_required":
          deps.log(`#${i} 402: credits used up. Stopping.`);
          stop = true;
          break;
        case "bad_input":
          throw new Error(`400 bad input: ${r.message}`);
        case "invalid_token":
          deps.tokens.delete(o.apiId);
          throw new Error(`The gateway rejected the stored token (${r.message}). Deleted it; run again to buy a new pack.`);
        case "unexpected":
          throw new Error(`Unexpected HTTP ${r.status}: ${r.text}`);
      }
      if (stop) break;
      i++;
      if (i <= o.calls) await deps.sleep(o.intervalMs);
    }

    deps.log(
      `Summary: ${s.passed} passed, ${s.notMet} promise not met, ${s.upstreamErrors} upstream errors, ${s.down} down. ` +
        `Credits left: ${s.lastRemaining ?? "?"}. Credit accounting ${s.creditAccountingOk ? "OK: refusals used no credits" : "MISMATCH"}.`,
    );
    return s;
  }
  ```
  `agents/buyer/src/env.ts`:
  ```ts
  import { config } from "dotenv";
  import { resolve } from "node:path";

  config({ path: resolve(import.meta.dirname, "../../../.env") });

  export function need(name: string): string {
    const v = process.env[name];
    if (!v) {
      console.error(`Missing ${name} in the repo-root .env`);
      process.exit(1);
    }
    return v;
  }
  ```
  `agents/buyer/src/cli/pack.ts`:
  ```ts
  import { parseArgs } from "node:util";
  import { setTimeout as sleep } from "node:timers/promises";
  import { resolve } from "node:path";
  import { need } from "../env.js";
  import { createPackPayer } from "../payClient.js";
  import { TokenStore } from "../tokenStore.js";
  import { runPackDemo } from "../packBuyer.js";

  const { values } = parseArgs({
    options: {
      api: { type: "string" },
      op: { type: "string", default: "getPrice" },
      symbol: { type: "string", default: "ADA" },
      calls: { type: "string", default: "20" },
      interval: { type: "string", default: "2000" },
      fresh: { type: "boolean", default: false },
    },
  });
  if (!values.api) {
    console.error("Usage: pnpm --filter @hirakumi/buyer pack -- --api <apiId> [--op getPrice] [--symbol ADA] [--calls 20] [--interval 2000] [--fresh]");
    process.exit(1);
  }

  const maxPackMicros = BigInt(process.env.MAX_PACK_MICROS ?? "5000000");
  const payer = createPackPayer({
    mnemonic: need("BUYER_MNEMONIC"),
    blockfrostProjectId: need("BLOCKFROST_PROJECT_ID"),
    blockfrostBaseUrl: process.env.BLOCKFROST_BASE_URL ?? "https://cardano-preprod.blockfrost.io/api/v0",
    maxPackMicros,
  });
  const tokens = new TokenStore(resolve(import.meta.dirname, "../../.tokens.json"));
  if (values.fresh) tokens.delete(values.api);

  console.log(`Buyer wallet ${payer.address}  spend cap ${maxPackMicros} micros per payment`);
  const summary = await runPackDemo(
    { fetch, buyPack: payer.buyPack, tokens, log: (l) => console.log(l), sleep: (ms) => sleep(ms), now: Date.now },
    {
      gatewayUrl: need("PUBLIC_BASE_URL"),
      apiId: values.api,
      opId: values.op,
      query: { symbol: values.symbol },
      calls: Number(values.calls),
      intervalMs: Number(values.interval),
      maxPackMicros,
      pendingTimeoutMs: 90_000,
      pendingPollMs: 3_000,
    },
  );
  process.exit(summary.creditAccountingOk ? 0 : 2);
  ```
- [ ] **Step 4: Run all buyer tests, expect PASS.**
  `pnpm --filter @hirakumi/buyer test` → `4 files, 30 passed`. `pnpm --filter @hirakumi/buyer typecheck` → exit 0.
- [ ] **Step 5: Commit.**
  ```bash
  git add agents/buyer
  git commit -m "feat(buyer): pack-buyer flow and CLI with credit accounting checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 11: escrow buyer (Masumi createPurchase) and CLI

**Files:** Create `agents/buyer/src/escrowBuyer.ts`, `agents/buyer/src/cli/escrow.ts`, `agents/buyer/test/escrowBuyer.test.ts`.
**Depends on:** `@hirakumi/core` `inputHash`/`outputHash` (P1) and `@hirakumi/masumi` `createPurchase` (P4). Contract additions A4, A5, A6.

**Interfaces:**
```ts
export type StartJobResponse = { job_id: string; blockchainIdentifier: string; payByTime: string; submitResultTime: string; unlockTime: string;
  externalDisputeUnlockTime: string; agentIdentifier: string; sellerVKey: string; input_hash: string; amounts: { amount: string; unit: string }[] };
export type JobStatus = { job_id: string; status: "awaiting_payment" | "running" | "completed" | "failed" | "expired"; output?: string; output_hash?: string; reasons?: string[]; message?: string };
export type CreatePurchaseInput = { agentIdentifier: string; blockchainIdentifier: string; inputHash: string; identifierFromPurchaser: string; sellerVKey: string;
  payByTime: Date; submitResultTime: Date; unlockTime: Date; externalDisputeUnlockTime: Date; amountMicros: bigint };   // = @hirakumi/masumi createPurchase arg 2
export class WrongEscrowAssetError extends Error {}
export class InputHashMismatchError extends Error {}
export type EscrowResult = { outcome: "completed"; output: string; outputVerified: boolean } | { outcome: "failed"; reasons: string[]; refundAfter: Date }
  | { outcome: "expired" } | { outcome: "down"; message: string };
export function runEscrowJob(deps: EscrowDeps, o: EscrowOptions): Promise<EscrowResult>;
```
CLI: `pnpm --filter @hirakumi/buyer escrow -- --api <apiId> [--symbol ADA]`.

- [ ] **Step 1: Write the failing test** `agents/buyer/test/escrowBuyer.test.ts`:
  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { inputHash, outputHash } from "@hirakumi/core";
  import { USDM_PREPROD_ASSET } from "@x402/cardano";
  import { runEscrowJob, WrongEscrowAssetError, InputHashMismatchError, type EscrowOptions, type JobStatus } from "../src/escrowBuyer.js";
  import { json, GW, API, MASUMI_UNIT } from "./fakeGateway.js";
  import type { FetchLike } from "../src/gatewayClient.js";

  const T = Date.UTC(2026, 9, 6, 8, 0, 0);
  const PURCHASER = "a1b2c3d4e5f60718293a";
  const OUTPUT = '{"symbol":"ADA","usd":0.27,"change24h":1.2,"timestamp":"2026-10-06T08:00:00.000Z"}';

  function fakeEscrow(o: { statuses: JobStatus["status"][]; unit?: string; badInputHash?: boolean; down?: boolean; reasons?: string[] }) {
    const statuses = [...o.statuses];
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith("/start_job")) {
        if (o.down) return json(503, { status: "unavailable", message: "API is Down" });
        const body = JSON.parse(String(init?.body)) as { identifier_from_purchaser: string; input_data: Record<string, unknown> };
        return json(200, {
          job_id: "job_1", blockchainIdentifier: "bc_1", agentIdentifier: "agent_1", sellerVKey: "vkey_1",
          payByTime: String(T + 600_000), submitResultTime: String(T + 900_000), unlockTime: String(T + 1_200_000), externalDisputeUnlockTime: String(T + 1_500_000),
          input_hash: o.badInputHash ? "0".repeat(64) : inputHash(body.identifier_from_purchaser, body.input_data),
          amounts: [{ amount: "1000000", unit: o.unit ?? MASUMI_UNIT }],
        });
      }
      if (url.includes("/status?job_id=job_1")) {
        const status = statuses.shift() ?? "running";
        if (status === "completed") return json(200, { job_id: "job_1", status, output: OUTPUT, output_hash: outputHash(PURCHASER, OUTPUT) });
        if (status === "failed") return json(200, { job_id: "job_1", status, reasons: o.reasons ?? ["/usd is required"] });
        return json(200, { job_id: "job_1", status });
      }
      return json(404, { error: "not_found" });
    };
    return fetch;
  }

  const opts: EscrowOptions = { gatewayUrl: GW, apiId: API, input: { symbol: "ADA" }, escrowUnit: MASUMI_UNIT, maxEscrowMicros: 5_000_000n, pollMs: 5_000, timeoutMs: 60_000 };

  function makeDeps(fetch: FetchLike) {
    let now = T;
    const lines: string[] = [];
    return {
      lines,
      deps: {
        fetch,
        createPurchase: vi.fn(async () => ({ purchaseId: "pur_1" })),
        inputHash,
        outputHash,
        log: (l: string) => lines.push(l),
        sleep: async (ms: number) => { now += ms; },
        now: () => now,
        newPurchaserId: () => PURCHASER,
      },
    };
  }

  describe("runEscrowJob", () => {
    it("locks funds with the exact start_job terms and returns a verified result", async () => {
      const h = makeDeps(fakeEscrow({ statuses: ["awaiting_payment", "running", "completed"] }));
      const r = await runEscrowJob(h.deps, opts);
      expect(r).toEqual({ outcome: "completed", output: OUTPUT, outputVerified: true });
      expect(h.deps.createPurchase).toHaveBeenCalledWith({
        agentIdentifier: "agent_1", blockchainIdentifier: "bc_1", inputHash: inputHash(PURCHASER, { symbol: "ADA" }),
        identifierFromPurchaser: PURCHASER, sellerVKey: "vkey_1",
        payByTime: new Date(T + 600_000), submitResultTime: new Date(T + 900_000), unlockTime: new Date(T + 1_200_000),
        externalDisputeUnlockTime: new Date(T + 1_500_000), amountMicros: 1_000_000n,
      });
    });

    it("on failure prints reasons and the automatic refund time", async () => {
      const h = makeDeps(fakeEscrow({ statuses: ["running", "failed"] }));
      const r = await runEscrowJob(h.deps, opts);
      expect(r).toEqual({ outcome: "failed", reasons: ["/usd is required"], refundAfter: new Date(T + 900_000) });
      expect(h.lines.join("\n")).toContain(`refunds automatically after ${new Date(T + 900_000).toISOString()}`);
    });

    it("refuses a job priced in the x402 pack asset without calling createPurchase", async () => {
      const h = makeDeps(fakeEscrow({ statuses: [], unit: USDM_PREPROD_ASSET.replace(".", "") }));
      await expect(runEscrowJob(h.deps, opts)).rejects.toThrow(WrongEscrowAssetError);
      expect(h.deps.createPurchase).not.toHaveBeenCalled();
    });

    it("refuses to lock funds when the gateway hashed a different input", async () => {
      const h = makeDeps(fakeEscrow({ statuses: [], badInputHash: true }));
      await expect(runEscrowJob(h.deps, opts)).rejects.toThrow(InputHashMismatchError);
      expect(h.deps.createPurchase).not.toHaveBeenCalled();
    });

    it("returns down on 503 without locking", async () => {
      const h = makeDeps(fakeEscrow({ statuses: [], down: true }));
      expect(await runEscrowJob(h.deps, opts)).toEqual({ outcome: "down", message: "API is Down" });
      expect(h.deps.createPurchase).not.toHaveBeenCalled();
    });

    it("times out if the job never finishes", async () => {
      const h = makeDeps(fakeEscrow({ statuses: Array(100).fill("running") }));
      await expect(runEscrowJob(h.deps, { ...opts, timeoutMs: 20_000 })).rejects.toThrow(/did not finish/);
    });
  });
  ```
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @hirakumi/buyer exec vitest run test/escrowBuyer.test.ts` → cannot load `../src/escrowBuyer.js`.
- [ ] **Step 3: Implement** `agents/buyer/src/escrowBuyer.ts`:
  ```ts
  import { formatMicros, messageOf, safeJson, type FetchLike } from "./gatewayClient.js";

  export type StartJobResponse = {
    job_id: string; blockchainIdentifier: string; payByTime: string; submitResultTime: string; unlockTime: string;
    externalDisputeUnlockTime: string; agentIdentifier: string; sellerVKey: string; input_hash: string;
    amounts: { amount: string; unit: string }[];
  };
  export type JobStatus = {
    job_id: string; status: "awaiting_payment" | "running" | "completed" | "failed" | "expired";
    output?: string; output_hash?: string; reasons?: string[]; message?: string;
  };
  export type CreatePurchaseInput = {
    agentIdentifier: string; blockchainIdentifier: string; inputHash: string; identifierFromPurchaser: string; sellerVKey: string;
    payByTime: Date; submitResultTime: Date; unlockTime: Date; externalDisputeUnlockTime: Date; amountMicros: bigint;
  };
  export type EscrowDeps = {
    fetch: FetchLike;
    createPurchase: (p: CreatePurchaseInput) => Promise<{ purchaseId: string }>;
    inputHash: (identifier: string, input: unknown) => string;
    outputHash: (identifier: string, raw: string) => string;
    log: (line: string) => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    newPurchaserId: () => string;
  };
  export type EscrowOptions = {
    gatewayUrl: string; apiId: string; input: Record<string, unknown>; escrowUnit: string; maxEscrowMicros: bigint; pollMs: number; timeoutMs: number;
  };
  export type EscrowResult =
    | { outcome: "completed"; output: string; outputVerified: boolean }
    | { outcome: "failed"; reasons: string[]; refundAfter: Date }
    | { outcome: "expired" }
    | { outcome: "down"; message: string };

  export class WrongEscrowAssetError extends Error {}
  export class InputHashMismatchError extends Error {}

  const STRING_FIELDS = ["job_id", "blockchainIdentifier", "agentIdentifier", "sellerVKey", "input_hash"] as const;
  const TIME_FIELDS = ["payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime"] as const;
  const STATUSES = ["awaiting_payment", "running", "completed", "failed", "expired"];

  export function parseStartJob(body: unknown): StartJobResponse {
    const b = body as Record<string, unknown> | undefined;
    if (!b) throw new Error("start_job returned no JSON");
    for (const f of STRING_FIELDS) if (typeof b[f] !== "string" || b[f] === "") throw new Error(`start_job response lacks ${f}`);
    for (const f of TIME_FIELDS) if (typeof b[f] !== "string" || !/^\d+$/.test(b[f] as string)) throw new Error(`start_job ${f} must be an epoch-ms string`);
    const amounts = b.amounts;
    if (!Array.isArray(amounts) || amounts.some((a) => typeof a?.amount !== "string" || !/^\d+$/.test(a.amount) || typeof a?.unit !== "string")) {
      throw new Error("start_job amounts must be [{amount: micros string, unit}]");
    }
    return b as unknown as StartJobResponse;
  }

  export function parseJobStatus(body: unknown): JobStatus {
    const b = body as Partial<JobStatus> | undefined;
    if (!b || typeof b.job_id !== "string" || typeof b.status !== "string" || !STATUSES.includes(b.status)) {
      throw new Error(`bad /status response: ${JSON.stringify(body)}`);
    }
    return b as JobStatus;
  }

  const msDate = (ms: string) => new Date(Number(ms));

  export async function runEscrowJob(deps: EscrowDeps, o: EscrowOptions): Promise<EscrowResult> {
    const purchaserId = deps.newPurchaserId();
    const base = new URL(`/a/${encodeURIComponent(o.apiId)}/`, o.gatewayUrl);
    deps.log(`Starting a job on ${o.apiId} with input ${JSON.stringify(o.input)} (purchaser id ${purchaserId})`);

    const res = await deps.fetch(new URL("start_job", base).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ identifier_from_purchaser: purchaserId, input_data: o.input }),
    });
    const text = await res.text();
    if (res.status === 503) {
      const message = messageOf(safeJson(text), text);
      deps.log(`503 Down: ${message}. Nothing locked.`);
      return { outcome: "down", message };
    }
    if (!res.ok) throw new Error(`start_job failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    const job = parseStartJob(safeJson(text));

    if (job.amounts.length !== 1 || job.amounts[0].unit !== o.escrowUnit) {
      throw new WrongEscrowAssetError(`Job is priced in ${JSON.stringify(job.amounts)}; this buyer only pays escrow jobs in ${o.escrowUnit}`);
    }
    const amount = BigInt(job.amounts[0].amount);
    if (amount > o.maxEscrowMicros) throw new Error(`Job costs ${amount} micros, above the cap of ${o.maxEscrowMicros}`);
    const expected = deps.inputHash(purchaserId, o.input);
    if (job.input_hash !== expected) {
      throw new InputHashMismatchError(`Gateway input_hash ${job.input_hash} does not match ours (${expected}); not locking funds`);
    }

    deps.log(`Job ${job.job_id}: ${formatMicros(amount)} tUSDM in Masumi escrow; result due by ${msDate(job.submitResultTime).toISOString()}`);
    const { purchaseId } = await deps.createPurchase({
      agentIdentifier: job.agentIdentifier,
      blockchainIdentifier: job.blockchainIdentifier,
      inputHash: job.input_hash,
      identifierFromPurchaser: purchaserId,
      sellerVKey: job.sellerVKey,
      payByTime: msDate(job.payByTime),
      submitResultTime: msDate(job.submitResultTime),
      unlockTime: msDate(job.unlockTime),
      externalDisputeUnlockTime: msDate(job.externalDisputeUnlockTime),
      amountMicros: amount,
    });
    deps.log(`Purchase ${purchaseId} created: locking funds in escrow...`);

    const statusUrl = new URL("status", base);
    statusUrl.searchParams.set("job_id", job.job_id);
    const deadline = deps.now() + o.timeoutMs;
    let last = "";
    while (deps.now() < deadline) {
      const sr = await deps.fetch(statusUrl.toString(), { headers: { accept: "application/json" } });
      const st = parseJobStatus(safeJson(await sr.text()));
      if (st.status !== last) {
        deps.log(`status: ${st.status}`);
        last = st.status;
      }
      if (st.status === "completed") {
        const output = st.output ?? "";
        const outputVerified = st.output_hash !== undefined && st.output_hash === deps.outputHash(purchaserId, output);
        deps.log(`Result: ${output}`);
        deps.log(outputVerified ? "Output hash verified (MIP-004)." : "OUTPUT HASH MISMATCH: dispute before the dispute window closes.");
        return { outcome: "completed", output, outputVerified };
      }
      if (st.status === "failed") {
        const reasons = st.reasons ?? (st.message ? [st.message] : []);
        const refundAfter = msDate(job.submitResultTime);
        deps.log(`Failed, promise not met: ${reasons.join("; ")}`);
        deps.log(`No result was submitted, so Masumi refunds automatically after ${refundAfter.toISOString()}. No action needed.`);
        return { outcome: "failed", reasons, refundAfter };
      }
      if (st.status === "expired") {
        deps.log("Expired: funds were never locked in time.");
        return { outcome: "expired" };
      }
      await deps.sleep(o.pollMs);
    }
    throw new Error(`Job ${job.job_id} did not finish within ${o.timeoutMs}ms`);
  }
  ```
  `agents/buyer/src/cli/escrow.ts`:
  ```ts
  import { parseArgs } from "node:util";
  import { randomBytes } from "node:crypto";
  import { setTimeout as sleep } from "node:timers/promises";
  import { inputHash, outputHash } from "@hirakumi/core";
  import { createPurchase } from "@hirakumi/masumi";
  import { need } from "../env.js";
  import { runEscrowJob } from "../escrowBuyer.js";

  const { values } = parseArgs({ options: { api: { type: "string" }, symbol: { type: "string", default: "ADA" } } });
  if (!values.api) {
    console.error("Usage: pnpm --filter @hirakumi/buyer escrow -- --api <apiId> [--symbol ADA]");
    process.exit(1);
  }
  const masumi = { baseUrl: need("BUYER_PAYMENT_SERVICE_URL"), token: need("BUYER_PAYMENT_SERVICE_TOKEN"), network: "Preprod" as const };

  const result = await runEscrowJob(
    {
      fetch,
      createPurchase: (p) => createPurchase(masumi, p),
      inputHash,
      outputHash,
      log: (l) => console.log(l),
      sleep: (ms) => sleep(ms),
      now: Date.now,
      newPurchaserId: () => randomBytes(10).toString("hex"),
    },
    {
      gatewayUrl: need("PUBLIC_BASE_URL"),
      apiId: values.api,
      input: { symbol: values.symbol },
      escrowUnit: need("MASUMI_ESCROW_UNIT"),
      maxEscrowMicros: BigInt(process.env.MAX_ESCROW_MICROS ?? "5000000"),
      pollMs: 5_000,
      timeoutMs: 30 * 60_000,
    },
  );
  process.exit(result.outcome === "completed" || result.outcome === "failed" ? 0 : 1);
  ```
- [ ] **Step 4: Run, expect PASS.** `pnpm --filter @hirakumi/buyer test` → `5 files, 36 passed`. `pnpm --filter @hirakumi/buyer typecheck` → exit 0. A type error on `createPurchase(masumi, p)` means P4's signature drifted from the contract; raise it with P4 and do not cast.
- [ ] **Step 5: Verify the purchaser-id format** (unverified assumption: Masumi accepts a 20-char hex `identifierFromPurchaser`). Open `${BUYER_PAYMENT_SERVICE_URL%/api/v1}/docs` (through the A6 tunnel), find `POST /purchase`, read the `identifierFromPurchaser` constraints, and adjust `randomBytes(10)` if they differ.
- [ ] **Step 6: Commit.**
  ```bash
  git add agents/buyer
  git commit -m "feat(buyer): Masumi escrow buyer with input-hash and token-unit checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 12: preprod rehearsals at the gates (10h and 16h)

**Files:** none. Evidence is posted in team chat.

- [ ] **Step 12a (hour 10 gate): packs end to end.** With P1's gateway up and the demo API onboarded by hand (`DEMO_API_ID` from `select id from apis where name ilike '%price%'`):
  ```bash
  pnpm --filter @hirakumi/buyer pack -- --api $DEMO_API_ID --calls 6 --interval 3000 --fresh
  ```
  Expected: `402 credits_required`, `Buying pack ...`, `Paid in ~20-60s ... Tx https://preprod.cardanoscan.io/transaction/...`, then `#1 200 ...`. During calls 3–4, run in a second terminal:
  ```bash
  curl -s -XPOST $PRICE_API_URL/admin/break -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"mode":"empty"}'
  ```
  Expected: `#3 422 promise not met: ...` and then `credits unchanged` (or confirmation on the next 200). Within about 20s (`DEMO_MODE=1`), `#n 503 Down`. Reset with `{"mode":"ok"}` and run `--calls 3` again to see 200s after 2 passing probes. Post the terminal output plus the Cardanoscan link. Exit code must be 0 (`echo $?`).
- [ ] **Step 12b (hour 16 gate): escrow pass and fail.**
  ```bash
  ssh -N -L 3001:127.0.0.1:3001 ec2-user@$EC2_HOST &      # contract addition A6
  pnpm --filter @hirakumi/buyer escrow -- --api $DEMO_API_ID                    # pass → "Output hash verified"
  ```
  Fail run: start `escrow`. As soon as it prints `Purchase ... created`, set break mode `empty` (the gateway calls upstream only after FundsLocked, about 20–60s later). Expected `Failed, promise not met: ...` and the refund time. Reset mode `ok`. After `submitResultTime`, confirm the refund transaction on Cardanoscan for the purchasing wallet address. Post both outputs plus the refund tx link.
- [ ] **Step 12c: Measure the actual times** for the recording cuts: pack payment seconds, Down detection seconds, registry Offline lag, escrow lock seconds, refund wait. Post them in team chat.

---

### Task 13: demo script and recording checklist

**Files:** Create `docs/submission/demo-script.md`, `docs/submission/recording-checklist.md`.

- [ ] **Step 1: Write `docs/submission/demo-script.md` with exactly this content:**
  ```markdown
  # Hirakumi demo script (3:00 max)

  | Time | Segment | On screen | Narration (read at a calm pace) | Recording |
  |---|---|---|---|---|
  | 0:00–0:20 | Problem | Slide 2 | "AI agents want to pay for data per call. But API sellers can't reach them, and buyers pay even when the answer is broken. Paying per call on-chain is also too expensive on Cardano: about 1.4 ADA of overhead every time." | Live voice over slide |
  | 0:20–1:05 | Onboarding on Sokosumi | Sokosumi task → setup link → Endpoints → Ownership (challenge file Check passes, Eternl signs) → Review (promise in plain English, 100 calls for 2 tUSDM) → Publish | "Mika gives our coworker her OpenAPI link. Hirakumi finds the read-only endpoints, she proves she owns the API with a file and one wallet signature, and she approves a price and a promise: every answer must have a symbol, a price and a fresh timestamp." | Live; cut the Vercel redeploy and test-call wait |
  | 1:05–1:20 | Live on registry | Hirakumi API overview "Live" + Masumi agent explorer showing the agent Online | "About a minute later it's a registered Masumi agent, Online, with an honest health check behind it." | Cut registration wait (about 1 min) |
  | 1:20–1:50 | Agent buys a pack | Terminal: `pack` CLI → 402 with price, promise hash → paid → Cardanoscan tx tab → 200s with credits counting down, ~X ms | "Dev's agent hits the API, gets a 402 with the price and the promise, and pays once for 100 calls: one Cardano transaction, straight to Mika's wallet. Now each call is just HTTP, with no chain wait." | Cut the about 20s confirmation ("20 seconds later" caption) |
  | 1:50–2:25 | Break switch | Second terminal: `curl .../admin/break {"mode":"empty"}` → buyer prints 422 + "credits unchanged" → 503 Down → dashboard Down → Sokosumi comment → registry Offline | "Now Mika's API breaks and returns empty data. The agent gets a 422, the promise wasn't met, and no credit is used. Within 20 seconds the monitor marks it Down, new calls get a 503 before anyone pays, Mika gets a comment on her task, and the registry shows Offline." | Live up to Down; time-cut to registry Offline |
  | 2:25–2:45 | Escrow pass and refund | Pre-recorded: `escrow` CLI pass → result + "Output hash verified"; fail run → "refunds automatically after ..." → Cardanoscan refund tx | "Sokosumi users can hire per job through Masumi escrow. If the answer passes, the result is submitted. If not, nothing is submitted and Masumi refunds the buyer automatically." | Pre-recorded; heavy cuts |
  | 2:45–3:00 | Vision and business model | Slide 7 | "Hirakumi turns any API into a paid supplier for AI agents in three minutes, and buyers only pay for responses that pass. We earn an onboarding fee in Sokosumi credits and a small take rate on packs." | Live voice over slide |
  ```
- [ ] **Step 2: Write `docs/submission/recording-checklist.md` with exactly this content:**
  ```markdown
  # Recording checklist

  ## T-60 min: environment
  - [ ] EC2: `DEMO_MODE=1` in the gateway env, then `docker compose up -d gateway`. Check: `curl -s $PUBLIC_BASE_URL/a/$DEMO_API_ID/availability` → 200.
  - [ ] Price API: `curl -s $PRICE_API_URL/healthz` → `{"ok":true,"modeStore":"redis"}`; mode reset: `curl -s -XPOST $PRICE_API_URL/admin/break -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"mode":"ok"}'`.
  - [ ] Buyer wallet ≥ 10 tADA and ≥ 6 tUSDM (`USDM_PREPROD_ASSET`): check `https://preprod.cardanoscan.io/address/<buyer addr>`.
  - [ ] Payment-service purchasing wallet ≥ 10 tADA and ≥ 3 escrow tUSDM (`MASUMI_ESCROW_UNIT`).
  - [ ] Registry shows the demo agent Online (Masumi agent explorer).
  - [ ] `rm agents/buyer/.tokens.json` so the take starts with a 402.
  - [ ] Fresh onboarding draft ready for the Sokosumi segment (a second copy of the price API registered as a new API, or the seeded draft from P3).
  - [ ] Escrow pass and fail clips already recorded (Task 12b) with the Cardanoscan refund tx.

  ## T-15 min: screen
  - [ ] 1920×1080, browser zoom 125%, terminal font ≥ 18pt, dark theme, Do Not Disturb on, Slack/Discord closed.
  - [ ] No secrets on screen: no `.env`, no `vercel env`, shell history cleared (`clear`), the ADMIN_TOKEN curl uses `$ADMIN_TOKEN`.
  - [ ] Browser tabs, in order: (1) slides; (2) Sokosumi task; (3) Hirakumi web setup/review; (4) Hirakumi API overview; (5) Masumi agent explorer filtered to "Hirakumi"; (6) preprod.cardanoscan.io (buyer address); (7) payment-service escrow view; (8) Base Sepolia ScoreRegistry on sepolia.basescan.org (only if CRE shipped).
  - [ ] Terminal A (buyer): `pnpm --filter @hirakumi/buyer pack -- --api $DEMO_API_ID --calls 30 --interval 2000` typed but not run.
  - [ ] Terminal B (seller): the break curl typed but not run.

  ## Takes
  - [ ] Record each segment separately (OBS scene per segment), then edit to ≤ 3:00 total.
  - [ ] Time-cuts, each shown with a small caption ("≈20 s later"): pack tx confirmation (20–60s); Vercel redeploy for the challenge file; QA test calls; registry registration (about 1 min); registry Offline lag; escrow lock and refund wait.
  - [ ] Show the Cardanoscan pack tx for ≥ 2s with the tUSDM amount and the seller address visible.
  - [ ] After recording: set mode `ok`, `DEMO_MODE` stays 1 until judging ends.

  ## Export
  - [ ] Length ≤ 3:00 (check in the editor; 2:55 target).
  - [ ] 1080p MP4, upload to YouTube **unlisted** and to the Drive folder; test both links in a private window.
  ```
- [ ] **Step 3: Commit.**
  ```bash
  git add docs/submission
  git commit -m "docs(submission): demo script and recording checklist" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 14: slides outline

**Files:** Create `docs/submission/slides-outline.md`. The deck itself is built in Google Slides inside the shared Drive folder.

- [ ] **Step 1: Write `docs/submission/slides-outline.md` with exactly this content:**
  ```markdown
  # Hirakumi slides (8 slides + appendix)

  1. **Title:** "Hirakumi (開く, to open): any API, sold to AI agents in three minutes. Buyers only pay for answers that pass." Team names, TOKEN2049 Origins, Cardano Agentic Commerce track.
  2. **Problem:**
     - Agents need paid data per call; API sellers have no way to reach them on Masumi without building an agent.
     - Buyers pay even when a response is broken or stale.
     - Per-call on-chain payment on Cardano costs about 1.2–1.5 ADA min-UTxO plus about 0.17 ADA fee, with a 20–60s confirmation.
  3. **Solution:** A Sokosumi coworker that turns an OpenAPI link into a Masumi-registered agent:
     - confirm endpoints, prove ownership (file + wallet signature), approve a price and a plain-English promise, Publish;
     - **call packs** over x402: one tUSDM payment straight to the seller for 100 calls;
     - **credits used only on pass**: a failing answer returns 422 and costs nothing;
     - **truthful health**: `/availability` returns 503 when the API is down, so the registry shows Offline.
  4. **Demo:** the video (embedded) or 3 screenshots: 402 with price and promise hash → Cardanoscan pack tx → 422 "credits unchanged" + Down.
  5. **How it fits Masumi:** table "Masumi already has → Hirakumi adds":
     registry NFT → one-step registration from OpenAPI; `/availability` health check → answers from real test calls; escrow auto-refund → an acceptance rule decides whether a result is submitted; MIP-004 hashes → rule hash published before purchase; Sokosumi coworkers → the onboarding coworker plus health alerts.
  6. **Architecture:** gateway (Express on EC2: x402 packs, credits, MIP-003, monitor) · Masumi payment service (registry, escrow) · Postgres · Caddy · coworker · Next.js dashboard on Vercel · `@x402/*` 2.26.0 on Cardano preprod with the hosted facilitator. Optional box: Chainlink CRE scorer (simulation) → ScoreRegistry on Base Sepolia.
  7. **Business model:**
     - Onboarding fee: billed in Sokosumi credits, about $10–20 per API.
     - Take rate on packs: 3% (second output if x402 supports it, else billed monthly).
     - Pro: faster probes, analytics, a scored badge.
     - Call-pack economics: about 1.4 ADA overhead once per pack = about 0.014 ADA per call at 100 calls, versus about 1.4 ADA per call if every call paid on-chain (100× cheaper per call). Non-custodial: pack payments go straight to the seller.
  8. **Roadmap:** packs paid into escrow (buyer protection if a seller disappears); public QA and pricing agents; drift detection; mainnet after the track; DNS ownership; upstream auth.
  - **Appendix:** edge cases we handle (replayed payment → same token; race for last credit → exactly one wins; settlement fails → token stays pending and unusable; SSRF guard; 15s upstream timeout).
  ```
- [ ] **Step 2: Build the deck** in Google Slides from the outline in the shared Drive folder. Share it as "Anyone with the link → Viewer". Put the link in `docs/submission/submission-checklist.md` (Task 17).
- [ ] **Step 3: Commit.**
  ```bash
  git add docs/submission/slides-outline.md
  git commit -m "docs(submission): slides outline" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 15: write-up template (prefilled)

**Files:** Create `docs/submission/writeup.md`.

- [ ] **Step 1: Write `docs/submission/writeup.md` with exactly this content.** At T-4h, replace each `(measured: …)` sentence with the numbers posted in Task 12c, and delete the CRE paragraph if CRE did not ship.
  ```markdown
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
  ```
- [ ] **Step 2: Commit.**
  ```bash
  git add docs/submission/writeup.md
  git commit -m "docs(submission): prefilled write-up" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 16: root README

**Files:** Create or replace `README.md` (coordinate with P1, who may have scaffolded one; P5 owns the final text).

- [ ] **Step 1: Write `README.md` with exactly this content:**
  ````markdown
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
  ````
- [ ] **Step 2: Verify every path the README names exists** (run at T-4h; delete the Chainlink section if CRE did not ship):
  ```bash
  for p in apps/gateway apps/web apps/coworker packages/core packages/db packages/masumi sellers/price-api agents/buyer/src/payClient.ts agents/buyer/src/packBuyer.ts agents/buyer/src/escrowBuyer.ts agents/buyer/src/cli/pack.ts agents/buyer/src/cli/escrow.ts docker-compose.yml cre/project.yaml cre/secrets.yaml cre/scorer/main.ts cre/scorer/logic.ts cre/scorer/workflow.yaml cre/scorer/config.staging.json contracts/score-registry/src/ScoreRegistry.sol; do test -e "$p" || echo "MISSING $p"; done
  ```
  Expected: no output. Also confirm the three live URLs answer 200.
- [ ] **Step 3: Commit.**
  ```bash
  git add README.md
  git commit -m "docs: README with per-technology file lists and run instructions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 17: submission checklist

**Files:** Create `docs/submission/submission-checklist.md`.

- [ ] **Step 1: Write `docs/submission/submission-checklist.md` with exactly this content:**
  ```markdown
  # Submission checklist. Deadline 7 Oct 2026 23:59 SGT; our target 21:00 SGT

  ## Track requirements (official brief)
  - [ ] Working prototype on Cardano preprod
  - [ ] Open-source repo with docs: GitHub repo **public**, `README.md` file lists per technology (Task 16 path check passes), MIT license
  - [ ] Live URL(s): dashboard https://hirakumi.vercel.app, gateway https://api.hirakumi.app, demo API https://hirakumi-price-api.vercel.app (all 200 from a private window)
  - [ ] Demo video **≤ 3:00** (YouTube unlisted + Drive), link opens in a private window
  - [ ] Slides: Google Drive link, "Anyone with the link → Viewer"
  - [ ] Short write-up: problem, technical approach incl. Cardano/Masumi/x402 infrastructure, deployment and scaling (`docs/submission/writeup.md`, measured numbers filled in)

  ## Order of submission
  1. [ ] Submit to the **main track** first (form on the track page): repo, live URL, video, slides, write-up.
  2. [ ] Then **add the Cardano "Agentic Commerce" track** to the same submission (or a second submission if the organisers said so in Task 1).
  3. [ ] Screenshot each confirmation page and post it in team chat.
  4. [ ] Re-open the submission and check every link works.

  ## Final checks (T-4h → T-1h)
  - [ ] `pnpm test` green on `main`; the tag `submission` is pushed
  - [ ] No secrets in the repo: `git log -p | grep -E 'BUYER_MNEMONIC=|ADMIN_TOKEN=|PAYMENT_SERVICE_TOKEN=|CRE_ETH_PRIVATE_KEY=' ` returns nothing with a value
  - [ ] `DEMO_MODE=1` stays on and the price API mode is `ok` during judging
  - [ ] Buyer and purchasing wallets keep ≥ 10 tADA so judges can re-run the buyer
  - [ ] The answer to "how many tracks?" (Task 1) is recorded here: ______ (filled at hour 2)

  ## Links (fill as created)
  - Repo:
  - Video:
  - Slides:
  - Write-up:
  ```
  (The blank fields are filled during the event with runtime links. They are a form to complete, not plan gaps.)
- [ ] **Step 2: Commit.**
  ```bash
  git add docs/submission/submission-checklist.md
  git commit -m "docs(submission): submission checklist" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 18 (STRETCH, gated): ScoreRegistry consumer contract (Foundry)

**Gate: start only if both the hour-10 and hour-16 gates passed and it is hour 18 or later. Timebox for Tasks 18–20 is 4 hours in total. If time runs out, stop, delete the Chainlink README section, and do not mention CRE in the video.**

**Files:** Create `contracts/score-registry/foundry.toml`, `contracts/score-registry/src/ScoreRegistry.sol`, `contracts/score-registry/src/interfaces/{IReceiver,IERC165,ReceiverTemplate}.sol`, `contracts/score-registry/test/ScoreRegistry.t.sol`.

**Interfaces:**
```solidity
contract ScoreRegistry is ReceiverTemplate {
  constructor(address forwarder);
  // report = abi.encode(string[] apiIds, bool[] up, bool[] probePass)
  function getScore(string calldata apiId) external view returns (uint16 uptimeBps, uint16 passRateBps, uint64 at, uint32 checks);
  event ScoreUpdated(string apiId, uint16 uptimeBps, uint16 passRateBps, uint64 at);
  error LengthMismatch();
}
```
Verified: Base Sepolia chain selector name `ethereum-testnet-sepolia-base-1`; simulation forwarder (MockKeystoneForwarder) `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`; production KeystoneForwarder `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` (docs.chain.link forwarder directory, 6 Oct). `ReceiverTemplate(address)` checks `msg.sender == forwarder` and then calls `_processReport(bytes calldata)`.

- [ ] **Step 1: Install Foundry and scaffold.**
  ```bash
  curl -L https://foundry.paradigm.xyz | bash && foundryup
  forge init --no-git contracts/score-registry && cd contracts/score-registry
  rm -f src/Counter.sol test/Counter.t.sol script/Counter.s.sol
  forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.4.0
  echo '@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/' > remappings.txt
  mkdir -p src/interfaces
  for f in IReceiver IERC165 ReceiverTemplate; do
    curl -sSfL "https://raw.githubusercontent.com/smartcontractkit/x402-cre-price-alerts/main/contracts/interfaces/$f.sol" -o "src/interfaces/$f.sol"
  done
  sed -i.bak '1a\
  // Copied from smartcontractkit/x402-cre-price-alerts (MIT, Copyright (c) 2025 SmartContract Inc.)' src/interfaces/*.sol && rm src/interfaces/*.bak
  ```
- [ ] **Step 2: Write the failing test** `contracts/score-registry/test/ScoreRegistry.t.sol`:
  ```solidity
  // SPDX-License-Identifier: MIT
  pragma solidity ^0.8.24;

  import {Test} from "forge-std/Test.sol";
  import {ScoreRegistry} from "../src/ScoreRegistry.sol";
  import {ReceiverTemplate} from "../src/interfaces/ReceiverTemplate.sol";

  contract ScoreRegistryTest is Test {
      ScoreRegistry reg;
      address forwarder = makeAddr("forwarder");

      function setUp() public {
          reg = new ScoreRegistry(forwarder);
      }

      function _report(string memory id, bool up, bool pass) internal pure returns (bytes memory) {
          string[] memory ids = new string[](1);
          bool[] memory ups = new bool[](1);
          bool[] memory passes = new bool[](1);
          ids[0] = id;
          ups[0] = up;
          passes[0] = pass;
          return abi.encode(ids, ups, passes);
      }

      function test_firstReportSetsFullScores() public {
          vm.warp(1_791_262_510);
          vm.prank(forwarder);
          reg.onReport("", _report("api_demo", true, true));
          (uint16 uptime, uint16 passRate, uint64 at, uint32 checks) = reg.getScore("api_demo");
          assertEq(uptime, 10_000);
          assertEq(passRate, 10_000);
          assertEq(at, 1_791_262_510);
          assertEq(checks, 1);
      }

      function test_accumulatesAcrossReports() public {
          vm.startPrank(forwarder);
          reg.onReport("", _report("api_demo", true, true));
          reg.onReport("", _report("api_demo", false, false));
          reg.onReport("", _report("api_demo", true, false));
          reg.onReport("", _report("api_demo", true, true));
          vm.stopPrank();
          (uint16 uptime, uint16 passRate,, uint32 checks) = reg.getScore("api_demo");
          assertEq(checks, 4);
          assertEq(uptime, 7_500);
          assertEq(passRate, 5_000);
      }

      function test_revertsWhenNotForwarder() public {
          vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, address(this), forwarder));
          reg.onReport("", _report("api_demo", true, true));
      }

      function test_revertsOnLengthMismatch() public {
          string[] memory ids = new string[](2);
          bool[] memory ups = new bool[](1);
          bool[] memory passes = new bool[](2);
          vm.prank(forwarder);
          vm.expectRevert(ScoreRegistry.LengthMismatch.selector);
          reg.onReport("", abi.encode(ids, ups, passes));
      }

      function test_unknownApiIsZero() public view {
          (uint16 uptime, uint16 passRate, uint64 at, uint32 checks) = reg.getScore("api_none");
          assertEq(uint256(uptime) + passRate + at + checks, 0);
      }
  }
  ```
- [ ] **Step 3: Run, expect FAIL.** `forge test` → compilation error `Source "src/ScoreRegistry.sol" not found`.
- [ ] **Step 4: Implement** `contracts/score-registry/src/ScoreRegistry.sol`:
  ```solidity
  // SPDX-License-Identifier: MIT
  pragma solidity ^0.8.24;

  import {ReceiverTemplate} from "./interfaces/ReceiverTemplate.sol";

  /// @title ScoreRegistry
  /// @notice Stores per-API uptime and probe pass rate written by the Hirakumi CRE scorer workflow (run in simulation).
  contract ScoreRegistry is ReceiverTemplate {
      struct Score {
          uint32 checks;
          uint32 upChecks;
          uint32 passChecks;
          uint16 uptimeBps;
          uint16 passRateBps;
          uint64 at;
      }

      mapping(bytes32 => Score) private scores;

      event ScoreUpdated(string apiId, uint16 uptimeBps, uint16 passRateBps, uint64 at);
      error LengthMismatch();

      constructor(address forwarder) ReceiverTemplate(forwarder) {}

      function _processReport(bytes calldata report) internal override {
          (string[] memory apiIds, bool[] memory up, bool[] memory probePass) = abi.decode(report, (string[], bool[], bool[]));
          if (apiIds.length != up.length || apiIds.length != probePass.length) revert LengthMismatch();
          for (uint256 i = 0; i < apiIds.length; i++) {
              Score storage s = scores[keccak256(bytes(apiIds[i]))];
              s.checks += 1;
              if (up[i]) s.upChecks += 1;
              if (probePass[i]) s.passChecks += 1;
              s.uptimeBps = uint16((uint256(s.upChecks) * 10_000) / s.checks);
              s.passRateBps = uint16((uint256(s.passChecks) * 10_000) / s.checks);
              s.at = uint64(block.timestamp);
              emit ScoreUpdated(apiIds[i], s.uptimeBps, s.passRateBps, s.at);
          }
      }

      function getScore(string calldata apiId)
          external
          view
          returns (uint16 uptimeBps, uint16 passRateBps, uint64 at, uint32 checks)
      {
          Score storage s = scores[keccak256(bytes(apiId))];
          return (s.uptimeBps, s.passRateBps, s.at, s.checks);
      }
  }
  ```
- [ ] **Step 5: Run, expect PASS.** `forge test` → `5 tests passed; 0 failed`.
- [ ] **Step 6: Deploy to Base Sepolia** (deployer key = `CRE_ETH_PRIVATE_KEY`, funded from https://portal.cdp.coinbase.com/products/faucet):
  ```bash
  forge create src/ScoreRegistry.sol:ScoreRegistry --rpc-url https://sepolia.base.org --private-key 0x$CRE_ETH_PRIVATE_KEY --broadcast --constructor-args 0x82300bd7c3958625581cc2f77bc6464dcecdf3e5
  export SCORE_REGISTRY=<"Deployed to:" address from the output>
  cast call $SCORE_REGISTRY "getForwarderAddress()(address)" --rpc-url https://sepolia.base.org   # 0x82300bd7c3958625581cc2f77bc6464dcecdf3e5
  ```
- [ ] **Step 7: Commit.**
  ```bash
  git add contracts/score-registry
  git commit -m "feat(cre): ScoreRegistry CRE consumer contract on Base Sepolia" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 19 (STRETCH): CRE scorer workflow

**Files:** Create `cre/project.yaml`, `cre/secrets.yaml`, `cre/.gitignore`, `cre/scorer/package.json`, `cre/scorer/tsconfig.json`, `cre/scorer/workflow.yaml`, `cre/scorer/logic.ts`, `cre/scorer/logic.test.ts`, `cre/scorer/main.ts`.

**Interfaces:**
```ts
export type ApiTarget = { apiId: string; probeUrl: string; requiredFields: string[] };
export type Config = { schedule: string; gatewayBaseUrl: string; apis: ApiTarget[];
  evm: { chainSelectorName: string; scoreRegistryAddress: string; gasLimit: string } };
export type Observation = { apiId: string; up: boolean; probePass: boolean };
export type Masks = { upMask: number; passMask: number };
export function isUp(status: number): boolean;
export function hasRequiredFields(bodyText: string, required: string[]): boolean;
export function toMasks(obs: Observation[]): Masks;
export function fromMasks(apis: ApiTarget[], m: Masks): Observation[];
export function encodeScoreReport(obs: Observation[]): `0x${string}`;
```
SDK names come from the official template and docs (6 Oct): `cre`, `Runner`, `getNetwork`, `hexToBase64`, `bytesToHex`, `TxStatus`, `ok`, `consensusIdenticalAggregation`, `type Runtime`, `type HTTPSendRequester`; `cre.capabilities.{CronCapability,HTTPClient,EVMClient}`; `runtime.report({encodedPayload, encoderName:"evm", signingAlgo:"ecdsa", hashingAlgo:"keccak256"})`; `evmClient.writeReport(runtime, {receiver, report, gasConfig:{gasLimit}})`. Observations go into consensus as an object of numbers (bitmasks), the same shape as the template's `consensusIdenticalAggregation<{statusCode:number}>()`.

- [ ] **Step 1: Install the toolchain.**
  ```bash
  bun --version                       # must be ≥ 1.2.21
  curl -sSL https://app.chain.link/cre/install.sh | bash
  cre version && cre login
  ```
- [ ] **Step 2: Project files.**
  ```bash
  mkdir -p cre/scorer && cd cre
  cat > project.yaml <<'EOF'
  local-simulation:
    rpcs:
      - chain-name: ethereum-testnet-sepolia-base-1
        url: https://sepolia.base.org
  staging-settings:
    rpcs:
      - chain-name: ethereum-testnet-sepolia-base-1
        url: https://sepolia.base.org
  EOF
  printf 'secretsNames: {}\n' > secrets.yaml
  printf '.env\nscorer/node_modules\n' > .gitignore
  printf 'CRE_ETH_PRIVATE_KEY=%s\nCRE_TARGET=staging-settings\n' "$CRE_ETH_PRIVATE_KEY" > .env   # 64 hex chars, no 0x
  cd scorer
  cat > workflow.yaml <<'EOF'
  local-simulation:
    user-workflow:
      workflow-name: "hirakumi-scorer"
    workflow-artifacts:
      workflow-path: "./main.ts"
      config-path: "./config.staging.json"
      secrets-path: "../secrets.yaml"
  staging-settings:
    user-workflow:
      workflow-name: "hirakumi-scorer-staging"
    workflow-artifacts:
      workflow-path: "./main.ts"
      config-path: "./config.staging.json"
      secrets-path: "../secrets.yaml"
  EOF
  cat > package.json <<'EOF'
  {
    "name": "@hirakumi/cre-scorer",
    "version": "0.1.0",
    "private": true,
    "main": "dist/main.js",
    "scripts": { "postinstall": "bunx cre-setup", "test": "bun test" },
    "license": "MIT"
  }
  EOF
  cat > tsconfig.json <<'EOF'
  {
    "compilerOptions": {
      "target": "esnext",
      "module": "ESNext",
      "moduleResolution": "bundler",
      "lib": ["ESNext"],
      "outDir": "./dist",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "forceConsistentCasingInFileNames": true
    },
    "include": ["main.ts"]
  }
  EOF
  bun add --exact @chainlink/cre-sdk@1.23.0 viem@2.57.3
  bun add --dev --exact @types/bun@1.2.21
  ```
- [ ] **Step 3: Write the failing test** `cre/scorer/logic.test.ts`:
  ```ts
  import { describe, it, expect } from "bun:test";
  import { decodeAbiParameters, parseAbiParameters } from "viem";
  import { isUp, hasRequiredFields, toMasks, fromMasks, encodeScoreReport, type ApiTarget } from "./logic";

  const apis: ApiTarget[] = [
    { apiId: "api_a", probeUrl: "https://a.test/price?symbol=ADA", requiredFields: ["symbol", "usd"] },
    { apiId: "api_b", probeUrl: "https://b.test/price?symbol=ADA", requiredFields: ["symbol", "usd"] },
  ];

  describe("scorer logic", () => {
    it("up only on 200", () => {
      expect(isUp(200)).toBe(true);
      expect(isUp(503)).toBe(false);
    });

    it("probe passes only when every required field is present", () => {
      expect(hasRequiredFields('{"symbol":"ADA","usd":0.27}', ["symbol", "usd"])).toBe(true);
      expect(hasRequiredFields("{}", ["symbol", "usd"])).toBe(false);
      expect(hasRequiredFields("not json", ["symbol"])).toBe(false);
      expect(hasRequiredFields('[{"symbol":"ADA"}]', ["symbol"])).toBe(false);
    });

    it("masks round-trip", () => {
      const obs = [
        { apiId: "api_a", up: true, probePass: false },
        { apiId: "api_b", up: false, probePass: true },
      ];
      const m = toMasks(obs);
      expect(m).toEqual({ upMask: 0b01, passMask: 0b10 });
      expect(fromMasks(apis, m)).toEqual(obs);
    });

    it("refuses more than 30 APIs per report", () => {
      const many = Array.from({ length: 31 }, (_, i) => ({ apiId: `api_${i}`, up: true, probePass: true }));
      expect(() => toMasks(many)).toThrow();
    });

    it("encodes the report the contract decodes", () => {
      const hex = encodeScoreReport([{ apiId: "api_a", up: true, probePass: false }]);
      const [ids, ups, passes] = decodeAbiParameters(parseAbiParameters("string[] apiIds, bool[] up, bool[] probePass"), hex);
      expect(ids).toEqual(["api_a"]);
      expect(ups).toEqual([true]);
      expect(passes).toEqual([false]);
    });
  });
  ```
- [ ] **Step 4: Run, expect FAIL.** `cd cre/scorer && bun test` → `Cannot find module './logic'`.
- [ ] **Step 5: Implement** `cre/scorer/logic.ts`:
  ```ts
  import { encodeAbiParameters, parseAbiParameters } from "viem";

  export type ApiTarget = { apiId: string; probeUrl: string; requiredFields: string[] };
  export type Config = {
    schedule: string;
    gatewayBaseUrl: string;
    apis: ApiTarget[];
    evm: { chainSelectorName: string; scoreRegistryAddress: string; gasLimit: string };
  };
  export type Observation = { apiId: string; up: boolean; probePass: boolean };
  export type Masks = { upMask: number; passMask: number };

  const MAX_APIS = 30;

  export function isUp(status: number): boolean {
    return status === 200;
  }

  export function hasRequiredFields(bodyText: string, required: string[]): boolean {
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return false;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    return required.every((k) => Object.hasOwn(body as object, k));
  }

  export function toMasks(obs: Observation[]): Masks {
    if (obs.length > MAX_APIS) throw new Error(`at most ${MAX_APIS} APIs per report`);
    let upMask = 0;
    let passMask = 0;
    obs.forEach((o, i) => {
      if (o.up) upMask |= 1 << i;
      if (o.probePass) passMask |= 1 << i;
    });
    return { upMask, passMask };
  }

  export function fromMasks(apis: ApiTarget[], m: Masks): Observation[] {
    return apis.map((a, i) => ({ apiId: a.apiId, up: (m.upMask & (1 << i)) !== 0, probePass: (m.passMask & (1 << i)) !== 0 }));
  }

  export function encodeScoreReport(obs: Observation[]): `0x${string}` {
    return encodeAbiParameters(parseAbiParameters("string[] apiIds, bool[] up, bool[] probePass"), [
      obs.map((o) => o.apiId),
      obs.map((o) => o.up),
      obs.map((o) => o.probePass),
    ]);
  }
  ```
  `cre/scorer/main.ts`:
  ```ts
  import {
    cre,
    Runner,
    getNetwork,
    hexToBase64,
    bytesToHex,
    TxStatus,
    ok,
    consensusIdenticalAggregation,
    type Runtime,
    type HTTPSendRequester,
  } from "@chainlink/cre-sdk";
  import { type Config, type Masks, isUp, hasRequiredFields, toMasks, fromMasks, encodeScoreReport } from "./logic";

  // Runs on every DON node; results go through identical-value consensus.
  const probeAll = (sendRequester: HTTPSendRequester, config: Config): Masks => {
    const obs = config.apis.map((api) => {
      const availability = sendRequester
        .sendRequest({ url: `${config.gatewayBaseUrl}/a/${api.apiId}/availability`, method: "GET" as const })
        .result();
      const probe = sendRequester.sendRequest({ url: api.probeUrl, method: "GET" as const }).result();
      const probeText = new TextDecoder().decode(probe.body);
      return { apiId: api.apiId, up: isUp(availability.statusCode), probePass: ok(probe) && hasRequiredFields(probeText, api.requiredFields) };
    });
    return toMasks(obs);
  };

  const onCron = (runtime: Runtime<Config>): string => {
    const http = new cre.capabilities.HTTPClient();
    const masks = http.sendRequest(runtime, probeAll, consensusIdenticalAggregation<Masks>())(runtime.config).result();
    const obs = fromMasks(runtime.config.apis, masks);
    for (const o of obs) runtime.log(`${o.apiId}: up=${o.up} probePass=${o.probePass}`);

    const network = getNetwork({ chainFamily: "evm", chainSelectorName: runtime.config.evm.chainSelectorName, isTestnet: true });
    if (!network) throw new Error(`Unknown chain ${runtime.config.evm.chainSelectorName}`);
    const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);

    const report = runtime
      .report({ encodedPayload: hexToBase64(encodeScoreReport(obs)), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
      .result();
    const write = evm
      .writeReport(runtime, { receiver: runtime.config.evm.scoreRegistryAddress, report, gasConfig: { gasLimit: runtime.config.evm.gasLimit } })
      .result();
    if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`writeReport failed with status ${write.txStatus}`);
    const txHash = bytesToHex(write.txHash || new Uint8Array(32));
    runtime.log(`ScoreRegistry updated: https://sepolia.basescan.org/tx/${txHash}`);
    return txHash;
  };

  const initWorkflow = (config: Config) => {
    const cron = new cre.capabilities.CronCapability();
    return [cre.handler(cron.trigger({ schedule: config.schedule }), onCron)];
  };

  export async function main() {
    const runner = await Runner.newRunner<Config>();
    await runner.run(initWorkflow);
  }

  main();
  ```
- [ ] **Step 6: Run, expect PASS.** `bun test` → `5 pass, 0 fail`.
- [ ] **Step 7: Commit.**
  ```bash
  git add cre
  git commit -m "feat(cre): scorer workflow (cron, HTTP consensus, writeReport)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 20 (STRETCH): simulate with --broadcast, verify on-chain, document honestly

**Files:** Create `cre/scorer/config.staging.json`. Modify `README.md` (Chainlink section already written in Task 16; keep or delete).

- [ ] **Step 1: Generate the config from real values.**
  ```bash
  cd cre/scorer
  jq -n --arg gw "$PUBLIC_BASE_URL" --arg api "$DEMO_API_ID" --arg probe "$PRICE_API_URL/price?symbol=ADA" --arg reg "$SCORE_REGISTRY" '{
    schedule: "0 0 * * * *",
    gatewayBaseUrl: $gw,
    apis: [{ apiId: $api, probeUrl: $probe, requiredFields: ["symbol","usd","change24h","timestamp"] }],
    evm: { chainSelectorName: "ethereum-testnet-sepolia-base-1", scoreRegistryAddress: $reg, gasLimit: "500000" }
  }' > config.staging.json
  cat config.staging.json
  ```
  (`requiredFields` is the `required` list of the price API's own OpenAPI `Price` schema, Task 5.)
- [ ] **Step 2: Dry simulation (no broadcast).**
  ```bash
  cd .. && cre workflow simulate scorer --target staging-settings --non-interactive --trigger-index 0
  ```
  Expected: `[USER LOG] api_...: up=true probePass=true`. Troubleshooting, each step unverified until seen:
  - Error about HTTP call limits → retry with `--limits none` (simulation-only flag) and say so in the README.
  - Error parsing `secrets.yaml` → remove the `secrets-path` lines from `workflow.yaml`.
  - Consensus/aggregation type error on `Masks` → change `probeAll` to return `{ statusCode: number }` packing both masks as `upMask * 2**30 + passMask` (the template's exact object shape), and unpack in `onCron`.
- [ ] **Step 3: Broadcast run.**
  ```bash
  cre workflow simulate scorer --target staging-settings --non-interactive --trigger-index 0 --broadcast
  ```
  Expected: `ScoreRegistry updated: https://sepolia.basescan.org/tx/0x...`. Open the link; the tx `to` is the forwarder `0x82300bd7…f3e5` and it emits `ScoreUpdated`.
- [ ] **Step 4: Verify the stored score.**
  ```bash
  cast call $SCORE_REGISTRY "getScore(string)(uint16,uint16,uint64,uint32)" $DEMO_API_ID --rpc-url https://sepolia.base.org
  ```
  Expected: `10000 10000 <unix time> 1`. Run Step 3 again with break mode `empty` (wait until Down). Expected after: `5000 5000 <time> 2`. Reset mode `ok`.
- [ ] **Step 5: Honest docs.** Keep the README Chainlink section exactly as written in Task 16 ("CRE workflow run in simulation … not deployed to a DON"). Add the two Basescan tx links under it. Add one sentence to `docs/submission/writeup.md` with the tx link. In slides, label the box "Chainlink CRE (simulation)".
- [ ] **Step 6: Commit.**
  ```bash
  git add cre README.md docs/submission/writeup.md
  git commit -m "docs(cre): simulated scorer run with Base Sepolia evidence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

## Self-Review

**Spec coverage**
- §13 demo (0:00–3:00 timing, pre-recorded escrow, time-cuts) → Task 13. §6.1 packs (402 → one x402 payment → bearer credits → 200/422, `X-Credits-Remaining`, pending until settle) → Tasks 7–10, 12a. §6.2 escrow (start_job → lock → status → completed or failed + auto-refund after `submitResultTime`) → Task 11, 12b. §3 flow 4 (break → 422 no credit → Down within 20s → 503) → Tasks 3–4 break modes, Task 10 accounting, Task 12a. §5 ownership file at `/.well-known/hirakumi/<apiId>.txt` → Task 5, Task 6 Step 5. §9 monetization and call-pack economics → Task 14 slide 7. §12 P5 spike question (tracks) → Task 1. CRE gated at hour 18 with a 4h timebox and honest wording → Tasks 18–20. Submission requirements (public repo, live URL, Drive slides, ≤ 3-min video, write-up, main track first then Cardano, 7 Oct 23:59 SGT) → Task 17.
- Out of scope as instructed: the "LLM agent" buyer mode.

**Placeholder scan.** Every code step contains complete code. The remaining angle-bracket values are runtime data shown on screen or printed by a command (apiId/token from the Ownership screen, the deployed contract address, EC2 host), and the "Links" fields in the submission checklist are a form filled during the event. None of them hides a design decision.

**Type consistency.** `FetchLike` is defined once in `gatewayClient.ts` and reused by `packBuyer.ts`, `escrowBuyer.ts` and tests. `PackPurchase` (payClient) is the return type of `buyPack` in `PackDemoDeps`. `CreatePurchaseInput` mirrors the contract's `createPurchase` second argument field for field; `cli/escrow.ts` passes it straight to `@hirakumi/masumi`, so typecheck catches drift. The `Masks`/`Config` types are shared between `logic.ts` and `main.ts`. The Solidity report layout `(string[], bool[], bool[])` matches `encodeScoreReport`'s `parseAbiParameters` string, and a test checks it.

**Verified on 6 Oct.**
- `USDM_PREPROD_ASSET` value, `setSpendControls` / `SpendControlAsset` types, the $1 default cap refusing 2 tUSDM, and per-asset caps (ran the real `x402Client`).
- `toClientCardanoSigner` config, `wrapFetchWithPayment` signature, and `findDefaultAsset` / `SpendControls` exports.
- CoinGecko response shape (live probe), and the hosted facilitator `/supported` answering 200.
- Vercel Express entry paths, and the CRE CLI flags (`--broadcast`, `--non-interactive`, `--trigger-index`, `--target`, `--limits`).
- CRE TS SDK imports and the `report` / `writeReport` pattern (official template and docs), the Base Sepolia forwarder addresses, the `ReceiverTemplate` behaviour, and the template's MIT license.

**Not verified (each has a verification step):**
- Contract additions A1–A9 (P1/P4 must confirm).
- The Upstash env var names Vercel injects (Task 6 Step 3).
- Masumi `identifierFromPurchaser` format (Task 11 Step 5).
- CRE identical-consensus on an object of two numbers, HTTP-per-execution limits, and an empty `secretsNames` map (Task 20 Step 2 fallbacks).
- Whether `getPaymentSettleResponse` throws without a receipt header (guarded with try/catch).
- The organisers' answer on track count (Task 1).
- Whether CoinGecko rate-limits Vercel IPs (the fallback covers it; the `X-Price-Source` header shows which was used).
