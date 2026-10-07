# Status: Upstream Auth v3 (keyed APIs and their edge cases)

Branch `feat/upstream-auth-v3`. The full plan is in [`docs/plans/upstream-auth-v3.md`](docs/plans/upstream-auth-v3.md). Four rounds of adversarial review shaped it before implementation started.

## What this adds

1. **Multi-part sealed keys (`hks3`).** These are written only when the existing single-key `hks2` format can't express the credential:
   - 2 to 4 parts (header and/or query), for example Supabase's `apikey` plus `Authorization: Bearer`, a key plus a fixed `Notion-Version`, or a header plus a query key;
   - HTTP Basic with a username and password.

   The sealed data is bound to the API, every part's placement, name and order, and the canonical origin and path prefix. The gateway works out the password, the `user:pass` pair and the key after a scheme word itself, so a web-side leak list that leaves them out can't open a hole. `hks2` rows behave exactly as before.
2. **Key-aware failures on the existing Down path.**
   - **401/403 on a keyed call:** these give the reasons `KEY_REFUSED` / `KEY_FORBIDDEN`, and buyer 422s gain an `auth` field. Health checks feed them into the existing "Down after 3 failed checks" logic and the seller alert.
   - **Gateway can't read keys:** the API still goes Down, so sales stay gated, but the seller isn't messaged, because it's an operator problem.
3. **The key is checked when it's saved** (`POST /internal/apis/:id/check-key`). The gateway makes one real call with the sealed candidate key, and the seller sees "your API answered 401 with this key" with a **Save anyway** button. Nothing from the check is stored.
4. **Hardening:**
   - `accept-encoding: identity` is sent, and compressed answers from keyed APIs are withheld.
   - An upstream 429 becomes a free `503 upstream_rate_limited` with `Retry-After`. A health check answered 429 counts as inconclusive, so a buyer can't drive the API Down by burning the seller's quota.
   - Each buyer token gets at most 20 failed calls a minute, counted before the call so concurrent calls can't bypass it.
   - A wrong `UPSTREAM_AUTH_PUBLIC_KEY` is logged instead of crashing the gateway.
5. **Seller UI.** The form gains presets (Bearer, Basic, two headers, key plus fixed header, header plus query). A saved `hks3` key shows as a read-only list of its parts with a **Replace** button. There is also a **Check key now** button.

`hks3` writes are behind `UPSTREAM_AUTH_V3=1`. Deploy the gateway and coworker first, then the web app, then turn the flag on.

**Deliberately out of scope** (see plan §11):
- OAuth2 client credentials;
- HMAC request signing, which would make the gateway a signing oracle;
- keys in the URL path or the request body;
- per-endpoint keys, per-buyer keys and mTLS;
- gateway keypair rotation.

## How it was built

1. **Plan:** 3 readers mapped the code, 3 independent designs were judged and merged, then 4 adversarial review rounds of 2 reviewers each revised the plan. They raised 87 issues in total. Round 3 cut most of the earlier machinery, and round 4 caught two critical bugs.
2. **Implementation:** core, then 9 parallel slices with separate file ownership and separate test databases.
3. **Integration:** 4 package groups in parallel.
4. **Adversarial review of the code:** 4 lenses (security, money and gating, plan conformance, mismatches between slices). Each finding was then checked by an agent trying to disprove it, and every finding that survived has been fixed with a regression test:

| Finding | Fix |
|---|---|
| The `hks3` leak set dropped the key after scheme words other than Bearer/Token (`SSWS K`, `ApiKey K`) | The key after any scheme word is derived; short keys after a scheme word are refused |
| Concurrent calls bypassed the per-token failure limit | Calls are counted before the upstream call, and undone on a pass |
| check-key tested the old saved bag instead of the new candidate key | Fixed in `internal.ts` |
| Operator-only Down could hide a later seller-caused failure | The coworker sends the seller's Down message when probe failures happen while the API is still Down |
| A Basic username in the examples blocked the save with `KEY_IS_PUBLIC` | Only secret parts are checked |
| Only the first `Content-Encoding` header was read | All values are read |
| Fixed parts weren't labelled, the hint showed part of short keys, and the V3-off form and ask facts promised multi-part keys | UI, repo and facts fixes |

## Test status (last full parallel run, 19:22–19:31 on 2026-10-07)

| Package | Result |
|---|---|
| typecheck (all packages) | ✅ pass |
| `apps/web` | ✅ 669/669 |
| `apps/coworker` | ✅ 283/283 |
| `packages/core` | ✅ 509/509 |
| `apps/gateway` | ⚠️ 428/433. Run alone, the failing files pass (54/54 in `hybrid`, `internal.checkKey`, `upstreamAuth.contract`); the failures were 15 s timeouts at load average 10–13. `packs.test.ts` and `textAnswers.test.ts` haven't been rerun alone. |
| `agents/buyer` | ⚠️ 195/205. All 10 failures are escrow, datum and payer tests that took 6–26 s, which looks like timeouts under load. Not rerun alone. |
| `packages/db` | ⚠️ 4 failed (`channels`, `migrate`, `oneListing`, `settlement`) plus 1 in `iou.libsodium`. These tests weren't touched by this change; not rerun alone. |
| stress | ⚠️ prop+gateway: 4 failed. web: 42/42. Live load: 8/8. Not triaged. |

All suites were run at the same time on one machine. The baseline before this change had one environment-related stress failure.

**To do before merge:** rerun `agents/buyer`, `packages/db`, `apps/gateway` and stress, one at a time on a quiet machine, and fix anything that still fails.

## Follow-ups (not in this PR)

- **A: Store which endpoints need the key.** The OpenAPI parser computes `needsKey` per endpoint but never stores it. Today check-key may pick a public endpoint and report a wrong key as accepted. Store it per endpoint (migration `0018`), make check-key prefer a protected endpoint, and otherwise report "not checked".
- **B: Accept two keys at once in the parser.** `apps/coworker/src/openapi/parse.ts` still skips endpoints whose security needs two keys at once ("not supported yet"). `hks3` can now express these; pre-fill the matching preset.
- **C: Explain failed ownership checks on protected base URLs.** When the base URL answers 401 without `X-Hirakumi-Verify`, tell the seller to add the header before their auth check.
