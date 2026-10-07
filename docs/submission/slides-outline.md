# Hirakumi slides (10 slides and an appendix)

1. **Title:** "Hirakumi: monetize your APIs for AI agents. List any API in minutes; agents pay per call on Cardano, and only for answers that keep the promise." Team, TOKEN2049 Origins, Cardano Agentic Commerce track.
2. **Problem:** agents want to pay for API calls; API owners can't sell to them yet.
   - To sell on Masumi an API owner must build and register an agent, handle Cardano payments and run a health endpoint.
   - Paying per call on chain costs about 1.2 to 1.5 ADA min-UTxO plus about 0.17 ADA fee, and waits for a block.
   - A buyer agent paying a seller it has never met needs a reason to trust the answers.
3. **Solution: Hirakumi monetizes any API.**
   - Bring the API as it is: an OpenAPI link, or a base URL and a few example requests; JSON or text answers; nothing new to run.
   - **Keys included:** a key in a header or query, `Bearer`, HTTP Basic, or up to 4 parts at once, sealed so only the gateway can use it.
   - **Sold in packs over x402:** one payment buys 100 calls, settled to the seller's wallet.
   - **Listed on Masumi:** each API becomes a registered agent that buyer agents and Sokosumi can find and hire.
3b. **What makes it different:** buyers pay only for answers that keep the promise.
   - **Credits only on pass:** a promise inferred from real test calls (text answers need a phrase the seller confirms); a failing answer is a 422 and costs nothing.
   - **Truthful health:** we re-run the tests; `/availability` answers 503 when the API breaks, so the Masumi registry shows Offline.
   - **Proven ownership:** an `X-Hirakumi-Verify` response header (platform detected, snippet or "Let your AI do it" prompt) and one wallet signature, re-checked every 6 hours.
   - **Escrow when it matters** (next slide), **keys that fail safely** (slide 5), and about 0.014 ADA overhead per call instead of 1.4 ADA.
4. **Settlement, chosen per purchase:** direct (one tx to the seller, cheapest) or escrow in an Aiken contract (large pack, low uptime, new seller, or the buyer asks). In escrow the buyer signs an IOU per good answer; Close, Raise, Settle; the seller is paid only for signed calls; the buyer can always exit.
4b. **Why not just ask an AI to build it?** (main deck after escrow; 3-minute deck in the backup slides) The Sokosumi CLI hires agents, it doesn't sell an API. An AI-built agent: you host the code, the seller's code grades its own answers, every job is paid on chain, the status is whatever the seller says, nobody checks the API is yours. Hirakumi: nothing new to run, a neutral checker grades every answer, one payment for 100 answers, health tested and flagged by us, ownership proven. "An AI can write you an agent, but buyers still have to trust it. Hirakumi checks every answer, and the safe makes that check binding."
5. **APIs with keys: what goes wrong, and who pays.** A keyed API fails in ways a public one doesn't. Each case has one answer: the buyer never pays for it, and the right person hears about it.
   - **Wrong or revoked key:** a 401/403 is tagged "key refused" or "access forbidden". The buyer gets a free 422 with the reason. After 3 failed health checks the API is Down, sales stop, and the seller gets a message quoting the 401. A wrong key typed at save is caught before it is saved, with **Save anyway**.
   - **The API rate-limits us (429):** a free 503 with `Retry-After`. A health check answered 429 counts as inconclusive, so a buyer can't burn the seller's quota to knock the API Down.
   - **The API repeats its key:** the answer is withheld, in any common encoding, compressed answers included, and the credit goes back.
   - **Hirakumi can't read keys:** sales pause, but the seller isn't messaged, because it is our problem, not theirs.
   - **A buyer floods failing calls:** each token gets at most 20 failed calls a minute, counted before the call.
   - Planned in 4 adversarial review rounds (87 issues raised), built in parallel, then the code reviewed again; every confirmed finding fixed with a test. Open as PR #19 (`UPSTREAM_AUTH_V3`).
   - Not yet: OAuth2, request signing (HMAC), per-endpoint keys; a signing gateway would sign whatever a buyer sends.
6. **Demo:** the video, or three screenshots: 402 with price, promise hash and settlement reasons; Cardanoscan lock and Settle; 422 with the API marked Down.
7. **How it fits Masumi:** "Masumi has, Hirakumi adds": registry token, registration from an OpenAPI link; `/availability`, answers from real test calls; escrow refund, a promise decides whether a result is submitted; MIP-004 hashes, the rule hash published before purchase; Sokosumi coworkers, the onboarding coworker and health alerts.
8. **Architecture:** gateway (Express on EC2: x402 packs, credits, escrow watcher, MIP-003, monitor), Masumi payment service, Postgres, Caddy, coworker, Next.js web app on Vercel, `pack_escrow` Aiken validator, `@x402/*` 2.26.0 on preprod with the hosted facilitator.
9. **Business model and roadmap:**
   - 3% fee on escrow packs (an output of the contract today); onboarding fee in Sokosumi credits.
   - Economics: about 0.014 ADA overhead per call at 100 calls, versus about 1.4 ADA per call paid on chain.
   - Next: reference-script UTxO for cheaper spends, contract audit, mainnet USDM, escrow as the default for new sellers; OAuth2 client credentials and per-endpoint keys read from the OpenAPI file.
- **Appendix:** edge cases handled: a replayed payment returns the same token; a race for the last credit has exactly one winner; a failed settlement leaves the token pending and unusable; SSRF guard on every outbound call; a buyer that demands escrow never gets a silent direct offer; a key moved to another header, listing or address no longer opens; a key in the seller's public examples is refused; a flapping 401 during the seller's deploy doesn't mark the API Down (3 failed checks needed); on-chain evidence links (README).
