# Upstream Auth v3 (lean): multi-part sealed bags (hks3) and key-aware reasons on the existing Down gate (rev. after adversarial round 4)

## 0. Verdict and what changed

Round 3 showed that most of the round-2 machinery duplicated things the gateway already does. I checked each claim against the code:
- Every gateway process runs its own Monitor (`apps/gateway/src/main.ts:36-37`).
- Any probe that doesn't pass becomes a health reason (`monitor.ts:85-87`), and only the monitor calls `health.record` (`monitor.ts:92`).
- After `failsToDown=3` ticks at `probeIntervalMs=120s` (`config.ts:97,100`), the API turns Down. **Down is the only sales gate.** It blocks credit calls and the 402 offer (`credits.ts:48`), packs (`packs.ts:266`), the MIP-003 availability check and `start_job` (`mip003.ts:132,182`), and demoBuy (`demoBuy.ts:85`). None of these look at `credentialError`.
- The coworker already messages the seller with the failing reasons (`apps/coworker/src/alerts.ts:34-36`).
- Until the API turns Down, failed calls cost the buyer nothing, because every non-pass releases the credit (`credits.ts:134`). The paid route `/a/:apiId/x/:opId` has **no rate limit**; the only limiter is on `start_job` (`mip003.ts:81-100`, `createWindowLimiter`).
- Today the key is sent on every operation (`upstream.ts:89-91`), and `runOperation` skips all leak checks when `!api.credential` (`upstream.ts:136`).
- `apis.upstream_auth` has no CHECK constraint (0014/0015), so a new stored format needs no migration.
- The deployment runs one gateway behind a bare `reverse_proxy gateway:4021` (`Caddyfile:4-6`) with no health check, so nothing reads `/healthz`. The gateway gets the shared `.env` (`docker-compose.yml:48-50`), which holds `UPSTREAM_AUTH_PUBLIC_KEY` too (`.env.example:20`).

**The plan is three small things:**
1. **hks3 sealed bags**, used only where hks2 can't express the credential: two or more parts, or HTTP Basic with a public username. The web renders the values. The gateway does no templating. It re-checks framing, sends the parts and checks answers against a leak list sealed inside the bag, plus secrets it derives itself.
2. **Key-aware reasons on the existing health path.** A 401 or 403 on a call that carried the key gets a fixed reason (`KEY_REFUSED` / `KEY_FORBIDDEN`). Probes feed it into the existing Down logic and the existing seller alert. Buyer 422s gain an `auth` field. No new state.
3. **Seal-then-check at save, for display only.** One real call on the seller's own test input. The seller sees "your API answered 401 with this key" before saving. Nothing is persisted.

Plus four hardening items:
- send `accept-encoding: identity` and withhold compressed answers (keyed APIs);
- map an upstream 429 to `503 upstream_rate_limited` with `Retry-After`, and treat a probe 429 as inconclusive;
- a per-token limit on free (non-pass) calls;
- an operator-side key problem keeps gating sales through Down, but the seller isn't messaged.

**Round 4 changes:**
- **Missing or mismatched gateway key.** The instance-scope health skip, `/healthz` 503 and the boot exit are removed. A gateway that can't read keys now records an operator reason through `health.record`, so the API still turns Down and every existing gate applies. The coworker suppresses the seller message for that reason only (§1.7.3).
- **Public-key check.** A mismatched `UPSTREAM_AUTH_PUBLIC_KEY` no longer exits. `loadConfig` logs it and treats the private key as unusable, which leads to the same operator-reason path. It is tested in `config.test.ts`.
- **Shared-quota drain.** A probe answered 429 is inconclusive, and free failures are limited per token. §8.5 and row #29 are corrected.
- **Leak engine.** `textLeaksAny` decodes once and matches all needles. Leak entries are capped at 8, needles at 160, and a CPU budget test is added.
- **Gateway Basic and Bearer backstop.** The gateway derives the password, the `user:pass` pair and the Bearer/Token K itself.
- **One `resolveAuth(api)` helper** gates `runOperation` and `buildUpstreamRequest`. It replaces `if (!api.credential)` at `upstream.ts:136`, and credential-only literals behave as today.
- **hks2 open output is unchanged** (no new fields), and `getUpstreamAuth` stays backward compatible. The list of tests that change is now exact (§7.2).
- `keyAppearsIn` no longer runs on fixed values.
- check-key gains the class `accepted_unverified`.
- `review/page.tsx` and `agents/buyer` are added to the file list.
- The hks3 AAD uses the canonical helpers, the legacy POST also checks the key, and query names must be unique.

The work is about 480 LOC of code plus about 420 LOC of tests.

**Rejected (unchanged from earlier rounds):**
- Request-data templates (HMAC over buyer data): they would make the gateway a signing oracle.
- Path or body placement: it collides with `urlWithinBase`, the ownership proof and the buyer-owned `body`.
- Retrying a buyer's call after a refused key: replaying a request that may not be idempotent is unsafe.

**Who can list (scope note).** Ownership needs `X-Hirakumi-Verify` on the seller's own origin and path prefix (`packages/core/src/ownership.ts:3-8`). So third-party APIs (Stripe, OpenAI, GitHub, Google) can only be resold through the seller's own proxy. Sellers own the auth of the API they list, so they can always issue a static key. The realistic sellers are self-hosted APIs and API platforms (AWS API Gateway, Kong, Azure APIM, Supabase, GraphQL servers).

---

## 1. Core mechanism

### 1.1 hks2 stays the default
These saves keep writing **hks2**, byte for byte as today (`sealUpstreamSecret`):
- the simple form;
- the **Bearer** preset, which renders `Bearer <K>` and requires K to be at least 8 characters;
- the **custom prefix** preset (`Token <K>`, `ApiKey <K>`);
- **Basic with an empty password** (key-as-username). It renders `Basic b64(K:)`, and the hks2 leak heuristics already cover the user part.

The hks2 leak set stays `upstreamSecretParts(value)`. `openCredential`'s hks2 output is unchanged: `{credential, credentialError}`, with no new fields.

### 1.2 hks3 only when hks2 can't express it
hks3 is written for:
- 2–4 parts, such as the Supabase `apikey` plus `Authorization: Bearer` (same key), a key plus a fixed version header, or a header plus a query key;
- Basic with a **non-empty password**.

Stored and sealed shapes:
- **Public row:** `{v:3, parts:[{in:'header'|'query', name, hint}], sealed:'hks3.<addrTag>.<ephPub>.<iv>.<ct>.<tag>'}`. `hint` is the last 4 characters of a secret part's value when that value is 16 or more characters; otherwise it is `''`. It is always `''` for a fixed part.
- **Sealed plaintext (JSON, ≤ 8 KB):** `{values:string[], fixed:number[], leak:string[]}`. `values[i]` is sent as `parts[i]`.
- **Crypto:** the same X25519 + HKDF-SHA256 + AES-256-GCM as hks2, with prefix `hks3` and HKDF info `hirakumi upstream-auth v3`.
- **AAD:** `JSON.stringify(['hks3', apiId, parts.map(p => [p.in, p.in==='header' ? p.name.trim().toLowerCase() : p.name.trim()]), canonicalOrigin(origin), canonicalPathPrefix(pathPrefix)])`. These are the **same helpers as hks2** (`upstreamAuth.ts:49-67`), so a key saved at `/v1` opens at `/v1/`, exactly as hks2 does. The addrTag uses the same canonical address as hks2.
- **What the AAD protects:** changing a placement, a name, the order or the number of parts fails GCM, and calls are blocked as today. An address change gives `ADDRESS_CHANGED`. `hint` is display-only and not in the AAD.

### 1.3 The web renders, the gateway checks and backstops
**Leak rules on the web:**
- every secret field;
- every rendered value that contains a secret (`Bearer K`);
- for Basic, `user:password` and the password, but not the username;
- never a fixed value.
- Limits: 0–**8** entries, each 8–4096 characters. Secret fields and a non-empty Basic password must be at least 8 characters.

**What the gateway checks on open (`validateUpstreamBag`):**
- `values.length === parts.length`, with 1–4 parts.
- Each part passes `validateUpstreamPart`. This is today's rule set (reserved headers, no CR/LF, at most 4096 characters, printable ASCII), except that a fixed value only needs 1 character.
- Header names are unique (case-insensitive) **and query names are unique** (exact). `searchParams.set` would otherwise drop the earlier value silently.
- At least one part is not fixed.
- The leak list has at most 8 entries, each 8–4096 characters.
- **`leakParts`** is the deduped union of:
  - `leak`;
  - every non-fixed value;
  - for every non-fixed value matching `^Basic <b64>`: `basicCredentials(value)`'s password and pair when each is at least 8 characters (**not** the username);
  - for every non-fixed value matching `^(Bearer|Token)\s+K`: K when it is at least 8 characters.

  So a buggy or seller-crafted bag that leaves the password, the pair or K out of `leak` is still covered.
- Any failure gives a row `credentialError` ("this API's key could not be read. The seller should enter it again"), as today.

**Leak engine refactor (no behaviour change for hks2):**
- Add `textLeaksAny(text, parts[])`, which does the expensive work **once per text**: lowercase, `normaliseText` (and the `+`→space variant, only if some needle has a space), `unwrapBase64` and `decodedBase64Tokens`.
- It then builds one deduped needle list across all parts (`upstreamSecretForms` ∪ `plainNeedles`), capped at **160** needles (a bag over the cap fails validation), and checks each scanned text with `includes` per needle.
- `textLeaksSecret(t, v)` becomes `textLeaksAny(t, upstreamSecretParts(v))`, and the same split applies to `redactUpstreamParts`.
- hks3 passes its explicit `leakParts`, so the username heuristic never runs on hks3.

### 1.4 One access helper for both formats
- **`UpstreamAccess`** gains an **optional** `auth?: {parts:{in,name,value}[], leakParts:string[]}`, set only for hks3. For hks3, `credential` is `null`.
- **`resolveAuth(api)`** in `upstream.ts`:
  ```ts
  resolveAuth(api) = api.auth ?? (api.credential
    ? {parts:[api.credential], leakParts: upstreamSecretParts(api.credential.value)}
    : null)
  ```
  It is the **only** way code reads the key:
  - `buildUpstreamRequest` applies its parts last, after `urlWithinBase` and the `credentialError` check;
  - `runOperation` uses it for the guard that replaces `if (!api.credential) return outcome` at line 136, for leak checks and redaction, for 401/403 tagging, and for compression withholding;
  - check-key uses it too.
- `leaksSecret` / `redactSecret` keep their signatures. Credential-only literals in existing tests behave exactly as today.

### 1.5 Key-aware reasons on the existing Down path
- **401:** in `runOperation`, when `resolveAuth(api)` is set and the upstream answered 401, prepend `KEY_REFUSED_TEXT`: "The API refused its key (HTTP 401). The seller should check or replace the key."
- **403:** prepend `KEY_FORBIDDEN_TEXT`: "The API refused access (HTTP 403): the key's permissions, an IP allowlist or a firewall."
- **Probes:** the reasons flow through `health.record`. After `failsToDown` failing ticks the API turns Down, every existing gate applies, and the coworker's Down message quotes the reason. `passesToHeal=2` heals it.
- **Buyer calls:** the reason appears in the 422 `reasons`, and the body gains `auth:'refused'|'forbidden'`. Buyer calls never call `health.record`.
- **Timing:** each instance gates after its own 3 failing ticks (about 4–6 minutes). Buyers lose nothing in that window.

### 1.6 Seal-then-check (display only)
- The web seals the candidate and posts the **sealed** blob to `POST /internal/apis/:id/check-key`.
- The gateway opens it under the row's own context and makes **one** real call (§5 internal.ts).
- It returns a class, the HTTP status and redacted constant reasons, never a body.
- Nothing is stored. The monitor and QA (`retryFailedQa`) remain the source of truth.
- Both the legacy `{in,name,value}` POST and the preset POST run it (§5).

### 1.7 Hardening
1. **Compression (keyed APIs).**
   - Send `accept-encoding: identity`, and add `accept-encoding` to `RESERVED_HEADERS`.
   - Withhold any answer with a non-identity `content-encoding`: 502 `upstream_error`, probe reason `KEY_UNSCANNABLE_TEXT`.
   - Reason: `undici.request` (`fetch.ts:171`) doesn't decode compression, so a gzip body would be scanned as garbage and forwarded.
2. **Upstream 429.**
   - **Paid call (every API):** 503 `upstream_rate_limited`, with `Retry-After` passed through when it parses (decimal seconds or an HTTP-date, clamped to 1–3600 s). The credit is released and `x-credits-remaining` is set.
   - **Probe:** a 429 is **inconclusive**, neither pass nor fail. `probeApi` adds no reason for that op and counts it in `inconclusive`.
     - If every probed op was inconclusive, `probeApi` returns without `health.record` (`touchHealthCheck` only), as the ownership recheck treats `'error'` (`monitor.ts:150`).
     - So quota exhaustion, whether a buyer drained it or the seller ran it out, never gates sales or blames the seller.
     - Accepted cost: while the seller's quota is exhausted, packs stay buyable. Buyers' calls are free 503s, and their credits stay unused until the quota resets.
3. **A gateway that can't read keys** (no `UPSTREAM_AUTH_PRIVATE_KEY`, or a key that fails the public-key check in 1.7.5):
   - `credentialError` is the existing text, exported as `KEYS_UNAVAILABLE` ("this API needs a key, and the gateway can't read keys right now"). Calls are blocked as today (502, credit released).
   - `Monitor.probeApi` checks for it **before the probe loop**. It makes no upstream calls and writes no probe `calls` rows. It records `health.record(apiId, false, [{op:'*', reason: OPERATOR_KEYS_UNAVAILABLE}])`, with the text "Hirakumi can't read API keys right now. This is our problem, not yours; sales are paused until we fix it." It logs `[monitor] operator: keys unavailable` once per API.
   - **Sales stay gated exactly as today:** Down after 3 ticks blocks the 402 offer, packs, `start_job`, availability and demoBuy.
   - **The seller isn't blamed.** `apps/coworker/src/alerts.ts` marks a `down` event notified **without enqueueing a message** when every reason is `OPERATOR_KEYS_UNAVAILABLE`. It does the same for the following `up` event when the most recent earlier `down` event for that API was operator-only (one indexed query).
   - The dashboard shows the operator text, which is honest.
   - No `/healthz` change. Nothing in this deployment reads it, and draining the only gateway would be a full outage.
4. **Free-failure limit per token.**
   - `credits.ts` keeps a sliding-window counter (generalising `createWindowLimiter` from `mip003.ts` into `apps/gateway/src/limiter.ts` with `blocked(key)` / `hit(key)`, about 15 LOC). The key is the credit token id or the channel id.
   - Every non-pass outcome calls `hit`.
   - Before reserving or calling upstream, a token at **20 non-pass in 60 s** gets `429 {error:'too_many_failed_calls'}` with `Retry-After`. It reserves nothing and makes no upstream call.
   - This bounds how fast one token can burn a seller's shared quota, and how much leak-scan CPU it can force, for free.
5. **Public-key check (never exits).**
   - In `config.ts` `loadConfig`: when both `UPSTREAM_AUTH_PUBLIC_KEY` and `UPSTREAM_AUTH_PRIVATE_KEY` are set and `publicKeyFromPrivate(priv) !== pub`, or the private key doesn't parse, it logs a loud `console.error`, sets `upstreamAuthPrivateKey: null` and sets `upstreamAuthKeyProblem: 'mismatch'|'unparseable'`.
   - The path in 1.7.3 then applies: no crash loop, and the ChannelWatcher, JobRunner, Reconciler and keyless APIs keep running.
   - The shared `.env` means this check is effectively always on in production. That is intended, now that it can't stop the process.
   - Web↔gateway mismatch is still caught at save by check-key `opened:false` → `NOT_SET_UP`.

---

## 2. Edge-case matrix

| # | Case | Handling | Supported? |
|---|---|---|---|
| 1 | Single static key in a header or query (existing hks2 rows) | Unchanged seal, open, inject and leak set. New: `accept-encoding: identity`, compressed answers withheld, key-aware 401/403 reasons. | yes |
| 2 | `Authorization: Bearer <key>` / `Token` / custom prefix | Preset renders `Bearer K` and writes hks2. K must be at least 8 characters. | yes |
| 3 | Same key in two headers (Supabase); app-id + key | hks3, 2 parts. Leak list: K and `Bearer K`; the gateway also derives K from `Bearer K`. | yes |
| 4 | Key + fixed non-secret header (`Notion-Version: 2022-06-28`) | hks3. The fixed part is sealed, sent as is, **not** leak-checked and **not** run through `keyAppearsIn`, so a version string in the seller's examples doesn't block the save. The form says "Fixed text isn't withheld if your API repeats it", with a non-blocking warning when `valueLooksLikeKey(value)`. | yes |
| 5 | Header + query mix | hks3 parts with mixed `in`. Query names must be unique. A query part uses `searchParams.set` after buyer fields, so it overrides a buyer field with the same name. | yes |
| 6 | HTTP Basic, key-as-username (empty password) | Renders `Basic b64(K:)` and writes **hks2**. The existing parts heuristic covers K, the pair and the b64. | yes |
| 7 | HTTP Basic, username + password | **hks3**. Leak list: password and `user:password`, which the gateway also derives itself from the `Basic` value. An echoed username is not withheld. A password under 8 characters is refused. | yes |
| 8 | Hand-pasted `Basic …` in an existing hks2 row | Legacy semantics unchanged. | yes |
| 9 | apiKey in a cookie | A header part `Cookie: name=K` (hks2). | partial |
| 10 | Login → Set-Cookie → re-login, CSRF pairs | Not built. | out of scope |
| 11 | Key needed only on some endpoints | Sent on every op, as today, on the seller's proven origin and prefix. | yes |
| 12 | Different ops need different keys | Not modelled. | out of scope |
| 13 | OAuth2 / JWT-bearer / service accounts | Not built (§11). | out of scope |
| 14 | Short-lived JWT pasted as a static key | Non-blocking warning at save when `exp` is less than 7 days away. At expiry: 401 → `KEY_REFUSED` → Down → alert. | partial |
| 15 | HMAC / request signing | Not built (signing oracle). | out of scope |
| 16 | Key in a path segment | Not supported. A non-blocking warning appears when a base-URL segment looks like a key. | warning only |
| 17 | Key in a JSON body | Not built. | out of scope |
| 18 | mTLS | Not built. | out of scope |
| 19 | Per-buyer BYO keys | Not built. | out of scope |
| 20 | IP-allowlisted keys | The form shows `GATEWAY_EGRESS_IPS` (shared by all sellers). A 403 on check-key mentions it. | partial |
| 21 | Wrong or typo'd key at save (any form) | check-key `refused`/`forbidden` gives 409 + [Save anyway], for the simple form and presets alike. Other platforms' wrong-key answers show as `forbidden`/`unclear` with status and reasons. | yes |
| 22 | Key saved before ownership is proven | check-key gives `unchecked` (not proven). After proof: QA, the monitor and "Check key now". | yes |
| 23 | No test input yet / no rule yet | Op choice: an op with a rule + saved input, else any enabled op with a saved input, else an enabled GET with no required params and `{}`, else `unchecked`. A 2xx with verdict `n/a` gives `accepted_unverified`. | yes |
| 24 | Web public key ≠ gateway private key | check-key `opened:false` → 503 `NOT_SET_UP`; nothing stored. | yes |
| 25 | Gateway has no private key, or its private and public keys mismatch | `KEYS_UNAVAILABLE`: calls blocked (502, free). Probes record `OPERATOR_KEYS_UNAVAILABLE` → Down after 3 ticks, so **every sales gate still applies**. The coworker sends no seller message. No crash. | yes |
| 26 | Row can't be opened (corrupt, tampered, hks1, bad bag) | Row `credentialError` as today → Down, and the seller is alerted. | yes |
| 27 | Address changed after save | `ADDRESS_CHANGED` (both formats, canonical address). | yes |
| 28 | Key revoked mid-pack | Buyers get 422 + `auth:'refused'`, free. After 3 ticks, Down gates everything, and the seller gets a message quoting `KEY_REFUSED`. | yes |
| 29 | Buyer crafts input that makes the upstream answer 401/403/429 | That call fails, free. Buyer calls never feed health. **Shared-quota path:** buyer calls can burn the seller's per-key quota. This is bounded per token (§1.7.4), and a probe 429 is inconclusive, so it can't gate. Platforms that report quota as **403** remain a limit: draining them can read as `KEY_FORBIDDEN` and turn the API Down. | partial |
| 30 | Seller's API answers 401 briefly during its own deploy | One tick doesn't gate (`failsToDown=3`). | yes |
| 31 | Upstream 429 / per-key quota | Paid: 503 + `Retry-After`, free. Probe: inconclusive, so no Down. Quota sent as 403 → `KEY_FORBIDDEN` → Down (see #29). | partial |
| 32 | Many buyers' failing calls draining quota | Per-token limit of 20 non-pass per minute. Many cheap tokens can still drain; probe 429 can't gate. | partial |
| 33 | Seller rotates the key; other instances cache the old one (`REGISTRY_TTL_MS=60s`) | Calls on stale instances 401 → 422, free. Normally never Down. Guidance: create new, save, wait a minute, revoke old. | yes |
| 34 | Gateway keypair rotation / compromise | Not in this plan (§11). | out of scope |
| 35 | DB writer moves a secret, reorders parts or relabels the version | GCM fails → blocked. Rollback to an earlier pair is availability-only. | yes, except rollback |
| 36 | Old gateway meets an hks3 row | Fails closed. The web writes hks3 only when `UPSTREAM_AUTH_V3=1` (§7). | yes |
| 37 | Upstream echoes a secret (hks2 or hks3) | Withheld (502), credit released. The `resolveAuth` guard ensures hks3 (`credential:null`) is checked. | yes |
| 38 | Compressed answer | Withheld, `KEY_UNSCANNABLE`. | yes |
| 39 | Partial, truncated or hashed echo | Documented limit. | partial |
| 40 | Secret already in public examples | `keyAppearsIn` for every leak entry and every **non-fixed** value. Fixed values are declared public and skipped. | yes |
| 41 | Secrets under 8 characters, non-ASCII | Refused. A fixed value can be 1+ printable ASCII characters. | out of scope |
| 42 | DELETE the key on a live API | As today. | yes |
| 43 | Self-test / public Try with a broken key | Down gates demoBuy. Try slots are handed back when no `x-credits-remaining` header came back. | yes |
| 44 | Pack / `start_job` / 402 offer while the key is refused, or keys are unavailable | Gated by Down after 3 ticks in both cases. | yes |
| 45 | GraphQL 200 + `errors` for a bad key | The rule fails → non-pass, free; probe fails → Down. | yes |
| 46 | Hostile bag (many parts, huge values, CRLF, reserved headers, duplicate header or query names, short or too many leak entries, over 160 needles) | Gateway validation on open; the same checks run on the web. | yes |
| 47 | Seller answers probe inputs well and buyers with 401 | Pre-existing limit. | out of scope |
| 48 | check-key misuse | Internal token, owner + CSRF, proven origins only, row context only, 6 per minute per API, one call, class + status only. | yes |
| 49 | Seller lists a 1 MB answer and fires parallel calls to stall the event loop with leak scans | Decode once, a 160-needle cap and at most 8 leak entries keep a max bag to ≤ 2× a single value's cost. Non-pass calls are limited per token. | yes |

---

## 3. Data model

- **No migration.** `apis.upstream_auth` jsonb holds one of:
  - hks2 `{in,name,sealed:'hks2.…',hint}` (unchanged);
  - hks3 `{v:3,parts:[{in,name,hint}],sealed:'hks3.…'}`;
  - dead hks1 rows.
- `StoredUpstreamAuth` in core becomes a union by `sealed` prefix.
- No new columns, tables or persisted status. `OPERATOR_KEYS_UNAVAILABLE` lives in `health_events.reasons` like any other reason.

---

## 4. Gateway behaviour

| Upstream result (keyed API) | Paid buyer call | Money | Probe / health | Seller sees |
|---|---|---|---|---|
| 2xx + rule pass | 200 | charged | pass | — |
| 401 | 422 `promise_not_met`, `auth:'refused'`, `KEY_REFUSED_TEXT` first | released | failure → Down after `failsToDown` | Down message quoting the 401 text |
| 403 | 422, `auth:'forbidden'`, `KEY_FORBIDDEN_TEXT` | released | failure → Down | Down message with the 403 text |
| 429 | 503 `upstream_rate_limited` + `Retry-After`, `x-credits-remaining` | released | **inconclusive** (no reason; if all ops are inconclusive, no `health.record`) | nothing |
| Answer leaks a secret | 502 withheld | released | failure | Down message |
| Non-identity `content-encoding` | 502 withheld | released | failure `KEY_UNSCANNABLE` | Down message |
| Row `credentialError` | 502 blocked (as today) | released | failure → Down | Down message |
| `KEYS_UNAVAILABLE` (no or mismatched private key) | 502 blocked (as today) | released | no upstream call; `OPERATOR_KEYS_UNAVAILABLE` → Down (sales gated) | **no message** (dashboard shows the operator text) |
| A token at 20 non-pass in 60 s | 429 `too_many_failed_calls` + `Retry-After`, no upstream call | none reserved | — | — |

Invariant: **a credit is consumed only on `upstream_ok` + pass + result** (unchanged).

---

## 5. File-by-file changes

### packages/core
- **`src/upstreamAuth.ts`:**
  - hks2 functions byte-identical.
  - `sealUpstreamBag` / `openUpstreamBag`: `ctx3 = {apiId, parts:[{in,name}], origin, pathPrefix}`, with the AAD and canonical helpers from §1.2 (about 50 LOC).
  - `validateUpstreamPart`, factored out of `validateUpstreamAuth`, which keeps its messages.
  - `validateUpstreamBag` (§1.3), including unique query names, at most 8 leak entries, the 160-needle cap and the Basic/Bearer derivation through `basicCredentials`.
  - `"accept-encoding"` added to `RESERVED_HEADERS`.
  - `textLeaksAny` / `redactUpstreamParts` (decode once, one needle list). `textLeaksSecret` / `redactUpstreamSecret` / `keyAppearsIn` become wrappers.
  - `publicKeyFromPrivate(privateKey)` (about 6 LOC).
- **`src/authPresets.ts`** (new, about 70 LOC):
  - `renderPreset(preset, fields) → {kind:'hks2', credential} | {kind:'hks3', parts, values, fixed, leak}`.
  - Presets: `single`, `bearer`, `basic`, `twoHeaders`, `keyPlusFixed`, `headerPlusQuery`.
  - The leak rules and `jwtExpiry`.
- **`src/fetch.ts`:** optional `retryAfter?` / `contentEncoding?` on `UpstreamResult`, and `parseRetryAfter`.
- **`src/reasons.ts`:**
  - `KEY_REFUSED_TEXT`, `KEY_FORBIDDEN_TEXT`, `KEY_UNSCANNABLE_TEXT`, `OPERATOR_KEYS_UNAVAILABLE`;
  - `isOperatorOnly(reasons)`, used by the coworker.
- **`src/index.ts`:** exports.

### apps/gateway/src
- **`registry.ts`:**
  - `openCredential` branches on the prefix.
  - hks2: **output unchanged**.
  - hks3: `openUpstreamBag` + `validateUpstreamBag` → `{credential:null, credentialError:null, auth}`.
  - Export `KEYS_UNAVAILABLE` (the existing no-key text, unchanged).
  - `UpstreamAccess` gains optional `auth?`.
- **`upstream.ts`:**
  - Add `resolveAuth(api)` (§1.4).
  - `buildUpstreamRequest` applies `resolveAuth(api).parts` last (headers lowercased, query via `searchParams.set`) and sets `accept-encoding: identity` when there is auth.
  - `runOperation`:
    - `const auth = resolveAuth(api); if (!auth) return outcome;` replaces line 136;
    - `textLeaksAny` / `redactUpstreamParts` with `auth.leakParts`;
    - withholds a non-identity `contentEncoding`;
    - prepends the key reasons on 401/403.
  - `OperationOutcome` gains optional `auth?` and `retryAfter?`.
- **`limiter.ts`** (new, about 20 LOC): `createWindowLimiter` moved here from `mip003.ts` (mip003 imports it), plus `createFailureCounter(max, windowMs)` with `blocked(key)` / `hit(key)`.
- **`credits.ts`:**
  - Before reserving (or gating the channel): `failures.blocked(tokenId|channelId)` → 429 `too_many_failed_calls` + `Retry-After`.
  - In the non-pass branch near line 134: `failures.hit(...)`. Then, if status is 429, answer 503 `{error:'upstream_rate_limited', reasons}` + `Retry-After`.
  - The 422 body adds `auth` when set.
- **`monitor.ts`** (`probeApi`):
  - Right after `registry.get`: if `loaded.api.credentialError === KEYS_UNAVAILABLE`, log once per API, `health.record(apiId, false, [{op:'*', reason: OPERATOR_KEYS_UNAVAILABLE}])` with the usual transition handling, and return. There is no probe loop and no `calls` rows.
  - In the loop: an outcome with `result?.status === 429` adds no reason and increments `inconclusive`.
  - After the loop: if `probed > 0 && inconclusive === probed`, `touchHealthCheck` and return `null`.
- **`config.ts`:** reads optional `UPSTREAM_AUTH_PUBLIC_KEY`. On a mismatch or an unparseable key it logs, sets `upstreamAuthPrivateKey: null` and sets `upstreamAuthKeyProblem` (§1.7.5). It never throws. `main.ts` is unchanged.
- **`internal.ts`:** `POST /internal/apis/:apiId/check-key {stored?}` (about 65 LOC):
  - Internal token, and 6 per minute per API (`limiter.ts`).
  - Loads the row fresh. From `ownership_verified` onward and not retired; otherwise `{class:'unchecked', why:'not_proven'}`.
  - Opens `stored`, or the row's key, under the row's context. A failure, or `KEYS_UNAVAILABLE`, gives `{opened:false}`.
  - **Op choice:** an enabled op with a rule and a saved input; else any enabled op with a saved input; else an enabled GET with no required params and `{}`; else `{class:'unchecked', why:'no_test_input'}`.
  - **The call:** one `runOperation` with `probe:true` and timeout `min(config.upstreamTimeoutMs, 15_000)`. No `calls` row, no health.
  - **Class:**
    - `ok` (upstream_ok + pass);
    - `accepted_unverified` (2xx + verdict `n/a`);
    - `refused` (401);
    - `forbidden` (403);
    - `rate_limited` (429);
    - `timeout`;
    - `echoed`;
    - `unclear` (other non-pass).
  - **Returns** `{opened, class, status?, op, reasons?}`, with reasons redacted and never a body.

### apps/coworker
- **`src/alerts.ts`** (about 15 LOC):
  - For a `down` event where `isOperatorOnly(reasons)`, update `notified_at` without `enqueueMessage`.
  - For an `up` event, if the latest earlier `down` event for that API (`where api_id=$1 and id<$2 and to_health='down' order by id desc limit 1`) was operator-only, do the same.

### apps/web
- **`lib/gateway.ts`:** `call()` gains an optional JSON body. `checkKey(apiId, stored?)` uses a 25 s timeout and returns `null` on any failure; it never throws.
- **`app/api/apis/[apiId]/upstream-auth/route.ts`:**
  - **POST** accepts the legacy `{in,name,value,saveAnyway?}` or `{preset, fields, saveAnyway?}`.
  - **Rendering:** `renderPreset`. hks3 output with `env.upstreamAuthV3()` off gives 409.
  - **Before sealing:** `keyAppearsIn` for every leak entry and every **non-fixed** value (the legacy path checks its value as today). Warnings are collected.
  - **Sealing:** hks2 or hks3.
  - **Checking (both paths):** if `gw.checkKey` exists, call it.
    - `opened:false` → 503 `NOT_SET_UP`.
    - `refused`/`forbidden` without `saveAnyway` → 409 `{check}`.
    - Anything else → save.
  - **Saving:** `setUpstreamAuth`, then `reloadQuietly` and `retryFailedQa`.
  - **Response:** the legacy fields, plus `check` only when a check ran and `warnings` only when non-empty. The fake gateway in `upstream-auth.test.ts` has no `checkKey`, so `:63-80` passes unchanged.
- **`app/api/apis/[apiId]/upstream-auth/check/route.ts`** (new): owner + CSRF, "Check key now".
- **`lib/repo/upstream-auth.ts`:**
  - `getUpstreamAuth` stays **backward compatible**. A legacy row returns `{in,name,hint}` exactly as today, so `upstream-auth.test.ts:88` is unchanged. A v3 row returns `{parts:[{in,name,hint}]}`.
  - Type `UpstreamAuthView = UpstreamAuthSetting | {parts: UpstreamAuthSetting[]}`, discriminated by `'parts' in v`.
  - It never selects `sealed`.
- **`lib/env.ts`:** `upstreamAuthV3()`, `gatewayEgressIps()`.
- **`components/upstream-auth-form.tsx`:**
  - The `initial` prop becomes `UpstreamAuthView | null`.
  - A legacy view renders as today.
  - A v3 view renders a read-only parts list (`Header apikey ••••WXYZ`, `Header Notion-Version (fixed)`) with **Replace**. Replace opens the preset form empty; secrets are never pre-filled.
  - The "How does your API take its key?" select, up to 4 rows (Secret / Fixed text), the check panel, warnings and the egress IPs note.
  - **[Save anyway]** for both the simple form and presets: it re-posts the same body with `saveAnyway:true`.
- **`app/apis/[apiId]/review/page.tsx`** (`:32`, `:54`), **`ownership/page.tsx`**, **`overview/page.tsx`:** pass the `UpstreamAuthView`. The ownership and overview pages show "Check key now" and the base-URL key warning.
- **`lib/try-handler.ts`** (around line 93): `slot.release()` when `x-credits-remaining` is absent.
- **`lib/try.ts`:** headlines for:
  - `upstream_rate_limited`;
  - `too_many_failed_calls`;
  - `auth:'refused'|'forbidden'`.
- **`lib/ask/facts.ts`:** updated facts.

### agents/buyer
- **`src/gatewayClient.ts`** (`:119`): before the generic 503 → `down` case, `error === 'upstream_rate_limited'` → `{kind:'rate_limited', retryAfter}`. A 429 with `too_many_failed_calls` → the same kind.
- **`src/packBuyer.ts`** (`:188`): on `rate_limited`, log "rate-limited, no credit used" and wait `Retry-After` (capped) before the next call.

---

## 6. Seller UX

- **Ownership page (key before proof):** "Saved sealed. Not checked yet: we check it once your address is proven." Warnings appear inline.
- **After proof / Check key now:**
  - ✓ "Accepted (HTTP 200 on GET /quotes, promise met)"
  - ✓ "Your API answered 200 with this key; the promise isn't built yet, so we couldn't check the answer" (`accepted_unverified`)
  - ✗ "Your API answered 401 with this key: typo or revoked key" [Save anyway]
  - ⚠ "Access blocked (403): the key's permissions, an IP allowlist (203.0.113.7, shared by all Hirakumi sellers) or a firewall" [Save anyway]
  - ⚠ "Rate-limited (429)"
  - ⚠ "Took too long to answer the check; saved unchecked"
  - ⚠ "Answered 200 but the promise failed: <reasons>"
  - ⚠ "Your API repeated its key in the answer; such answers are withheld"
  - "Couldn't tell; saved"
- **Key broken later:** the existing Down banner and coworker message quote `KEY_REFUSED_TEXT`.
- **Operator key problem:** the dashboard's Down banner shows `OPERATOR_KEYS_UNAVAILABLE` ("our problem, not yours"). No message is sent.
- **Try it live:**
  - 422 `auth:'refused'` → "Your API refused its key on this call. No credit used."
  - Down → existing copy, and the slot is handed back.

---

## 7. Backwards compatibility and deploy

1. hks2 rows: same seal, open (identical output), leak set and injection. The request gains only `accept-encoding: identity`.
2. **Tests that change (exact):**
   - None of the `openCredential` / `getUpstreamAuth` `toEqual`s change, because the hks2 output and the legacy view are unchanged. This covers `apps/gateway/test/upstreamAuth.test.ts:23,24,28,62`, `upstreamAuth.contract.test.ts:70`, `apps/web/.../upstream-auth.test.ts:67,88` and `upstreamAuth.test.ts:152`.
   - Credential-only literals (`upstream.test.ts:63-240`, `upstream.redact.test.ts:32`) pass through `resolveAuth` unchanged.
   - A grep at plan time found no existing gateway test asserting a keyed upstream 401/403 → 422 body, or a paid-call upstream 429. If the suite surfaces one, its new expected value is the leading reason + `auth` (422), or `503 {error:'upstream_rate_limited'}` (429).
   - A monitor test that expects the probe `calls` rows or the per-op `blocked` reason for a no-private-key API now expects zero probe rows and the single `OPERATOR_KEYS_UNAVAILABLE` reason.
3. **Deploy order:**
   1. Gateway + coworker (they read both formats; operator-only suppression).
   2. Web, with `UPSTREAM_AUTH_V3` off.
   3. Set `UPSTREAM_AUTH_V3=1` once every gateway runs the new build.

   If the gateway is rolled back after hks3 rows exist, those APIs fail closed and turn Down. To recover, roll forward or re-save.
4. **Buyer API:**
   - 422 gains an optional `auth` and a leading reason.
   - An upstream 429 becomes 503 `upstream_rate_limited` + `Retry-After`.
   - A new 429 `too_many_failed_calls`.
   - A compressed answer from a keyed API is withheld.
   - `agents/buyer` is updated in the same slice.

---

## 8. Security argument

1. **Plaintext stays on the gateway.** The web seals; check-key takes sealed blobs. The DB holds ciphertext, placements, names and 4-character hints.
2. **Binding.** The hks3 AAD covers apiId, every part's placement and name in order, and the canonical origin and prefix. A DB-only attacker can roll back to an earlier pair (availability-only) but can't move, add or re-point parts.
3. **No buyer influence on the credential.** Values are fixed at save, and parts are applied last.
4. **Leak containment.**
   - Every secret, rendered secret value and Basic pair is withheld in its known encodings.
   - **The gateway derives the password, the pair and the Bearer K itself**, so a web leak list that leaves them out can't open a hole.
   - All key reads go through `resolveAuth`, so hks3 (`credential:null`) can't skip the check.
   - Compressed answers are withheld.
   - Fixed values and a Basic username are deliberately not withheld.
   - Limit: partial, hashed or transformed echoes.
5. **Blame and DoS.**
   - Only seller probes change health.
   - Buyers can't make a probe fail through 401: the probe uses the seller's input.
   - **Buyers can burn a per-key upstream quota.** A probe 429 is inconclusive, so this can't gate sales or blame the seller. The per-token failure limit bounds the rate.
   - Remaining limit: platforms that report exhausted quota as **403** read as `KEY_FORBIDDEN` and can be driven Down (#29).
   - Leak-scan cost is bounded (decode once, needle cap, per-token failure limit).
6. **check-key is not a proxy or oracle.** Internal token, owner + CSRF, proven origins only, row context, 6 per minute per API, one call, class + status only.
7. **Operator misconfiguration** (missing or mismatched key):
   - It gates sales through the existing Down path, so nobody buys an unusable API.
   - It is never a crash loop, so escrow Raise/Settle, jobs and keyless APIs keep running.
   - It never messages sellers.
8. **Money.** Unchanged: charge only on a pass. Every new path releases the credit or never reserves it.

---

## 9. Test plan

### Unit (vitest)
- **`packages/core/test/upstreamAuth.v3.test.ts`** (new):
  - Round trip; sealed at `/v1`, opens at `/v1/` (canonical); origin trailing-slash.
  - Each of these fails GCM: reordering parts, renaming a header, flipping header/query, adding or removing a part, another apiId/origin/prefix (prefix → `UpstreamAddressChangedError`), relabelling the version.
  - Bag validation, each refused: 5 parts, a CRLF value, a reserved header (including `accept-encoding`), a duplicate header name in another case, a **duplicate query name**, all parts fixed, a leak entry of 7 characters, **9 leak entries**, over 160 needles.
  - **Backstop:** a Basic bag with `leak:[]` still has the password and pair in `leakParts`, but not the username; a `Bearer K` bag with `leak:[]` has K.
- **`packages/core/test/upstreamAuth.leak.test.ts`** (extend):
  - `textLeaksAny` doesn't flag an echoed Basic username, but flags the password, the pair and `Basic b64`.
  - `textLeaksSecret` results match the existing corpus snapshot.
- **`packages/core/test/authPresets.test.ts`** (new):
  - Each preset's kind, values and leak list.
  - Bearer K of 4 characters is refused.
  - Basic with an empty password → hks2; with a password → hks3; a 7-character password is refused.
  - `jwtExpiry`.
- **`packages/core/test/fetch.test.ts`:** `parseRetryAfter`.
- **`apps/gateway/test/config.test.ts`:**
  - A matching public key → private key kept.
  - A mismatch or an unparseable key → `upstreamAuthPrivateKey:null`, `upstreamAuthKeyProblem` set, no throw.
  - No public key → unchanged.
- **`apps/gateway/test/registry.test.ts`:**
  - The hks2 output is identical to today (no `auth` key).
  - hks3 opens with `credential:null` and `auth`.
  - No private key → `KEYS_UNAVAILABLE`.
  - A bad bag → row error.
- **`apps/gateway/test/upstream.test.ts`:**
  - `resolveAuth` on a credential-only literal equals today's parts and leak set.
  - An hks2 request equals today's `init` plus `accept-encoding: identity`.
  - hks3 applies both parts after buyer fields.
  - **hks3 echo:** a stub echoes each leak entry (raw, base64, `Basic b64`, and the derived password when the bag's `leak` is empty) → `upstream_error`, `result:null`, reasons redacted.
  - 401 → `KEY_REFUSED_TEXT` + `auth:'refused'`; 403 → forbidden; a keyless 401 has no `auth`.
  - gzip is withheld when keyed and passed through when keyless.
- **`apps/gateway/test/credits.test.ts`:**
  - An upstream 429 → 503 + `Retry-After`, credit released, `x-credits-remaining` set.
  - A 422 carries `auth`.
  - **An hks3 echo → 502 with the credit released.**
  - The 21st non-pass in 60 s on one token → 429 `too_many_failed_calls` with no upstream hit (stub counter) and no reservation. Another token is unaffected.
- **`apps/gateway/test/monitor.test.ts`:**
  - Three 401 ticks → Down with `KEY_REFUSED` in `health_events`.
  - One 401 tick then a pass → healthy.
  - **All ops 429 for 5 ticks → no `health.record`, still healthy.**
  - One op 429 and another failing → the failing reason only.
  - **No private key:** 3 ticks → Down with only `OPERATOR_KEYS_UNAVAILABLE`, zero probe `calls` rows, zero upstream hits. Then packs/offer/`start_job`/demoBuy answer 503 (one assertion each through the app).
- **`apps/gateway/test/internal.test.ts`** (check-key):
  - Each class, including **`accepted_unverified`** (an op with no rule answering 200).
  - Op-choice order (an op with a rule is preferred).
  - Unproven → unchecked; `opened:false`, including the no-private-key case.
  - Exactly one upstream call; the 7th request in a minute → 429.
  - No body in the answer; no `calls` row.
- **`apps/coworker/test/alerts.test.ts`:**
  - An operator-only down event → `notified_at` set, no message.
  - The following up event → no message.
  - A mixed-reason down event → message as today.
  - A seller-reason down after an operator-only one → message.
- **`agents/buyer/test/gatewayClient.test.ts`:** 503 `upstream_rate_limited` → `rate_limited` with `retryAfter`; any other 503 → `down`.
- **Web:**
  - The route stores hks2 for the Bearer and empty-password Basic presets, and hks3 for two headers with the flag on; 409 with the flag off.
  - **A fixed value that appears in the examples saves (200).** A secret that appears → 400 `KEY_IS_PUBLIC`.
  - check-key `refused` → 409 on **both** the legacy and preset paths; `saveAnyway` → stored. `opened:false` → 503.
  - The fake without `checkKey` → legacy response unchanged.
  - Warnings are non-blocking.
  - The display query never selects `sealed`; the legacy view is unchanged; the v3 view lists the parts.
  - `upstream-auth-form.test.tsx`: the simple form shows the 409 panel and [Save anyway] re-posts with `saveAnyway`; a v3 `initial` renders the parts and Replace opens an empty preset form.
  - The review page typechecks with the union.
  - `checkKey` uses 25 s and returns null.
  - try-handler releases the slot correctly.

### Contract
- **`apps/gateway/test/upstreamAuth.contract.test.ts`** (extend):
  - Every preset sealed through the web path opens on the gateway with the same parts.
  - The gateway's `leakParts` ⊇ the web's leak list **and** ⊇ the derived set (password/pair/K), computed independently in the test.
  - The `checkKey` response shape (all 8 classes) matches the web's parser.

### Stress / property
- **`stress/prop/secrets.test.ts`** (extend):
  - `textLeaksAny` redaction is complete for random bags.
  - **CPU budget:** on a 1 MB base64-heavy body, a max bag (8 leak entries + 4 values) costs ≤ 2× a single-value `textLeaksSecret`, plus the linearity check.
- **`stress/gateway/upstream.test.ts`** (extend):
  - Revoke the key mid-run: zero charged non-pass calls, Down within `failsToDown` ticks.
  - One buyer at 50 rps of 401-inducing inputs: no Down, and upstream hits ≤ 20 per minute per token after the first window.
  - Upstream answering 429 to everything for 10 min: no Down.
  - Seller flaps 401 for 5 s every 10 min: no Down.

---

## 10. Delivery slices (about 480 LOC of code + about 420 LOC of tests)

1. **Gateway + core + coworker + buyer agent** (about 290 LOC):
   - hks3 bag seal/open/validate with the backstop;
   - the `textLeaksAny` refactor;
   - presets;
   - registry hks3 open;
   - `resolveAuth`;
   - `upstream.ts` parts, `accept-encoding`, withholding, key reasons;
   - the `limiter.ts` failure counter;
   - credits 429 → 503;
   - monitor 429-inconclusive and the operator-key path;
   - the config public-key check;
   - check-key;
   - alerts operator suppression;
   - the buyer agent `rate_limited`.

   No hks3 rows exist yet, so this ships safely alone.
2. **Web** (about 190 LOC):
   - the preset form and the v3 view;
   - the route (both paths check, hks2/hks3 behind `UPSTREAM_AUTH_V3`, warnings);
   - Check key now;
   - the repo union view;
   - the review, ownership and overview pages;
   - try-handler slot release;
   - `try.ts` and `facts.ts`.

---

## 11. Deferred to separate plans

hks3 is versioned by prefix and HKDF info, so later features can add `hks4` or optional bag fields.

- **OAuth2 client-credentials** (token cache, mint caps, IdP host proof).
- **Gateway keypair rotation** (`_PREVIOUS`, reseal script).
- **Free failing calls** for every API, never counting seller-attributable failures, beyond the per-token limit here.
- **Quota-as-403 detection** (for example, a seller-declared "my platform uses 403 for quota" toggle), only if #29's residual shows up in practice.
- **Faster key gating than Down.**
- **Partial-echo (window) checks** for query keys.
- **Per-op keys, HMAC signing, per-buyer keys, mTLS, cookie login flows.**
