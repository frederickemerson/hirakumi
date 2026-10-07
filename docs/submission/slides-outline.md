# Hirakumi slides (8 slides and an appendix)

1. **Title:** "Hirakumi: make your APIs monetizable for AI agents. Buyers pay only for answers that keep the promise." Team, TOKEN2049 Origins, Cardano Agentic Commerce track.
2. **Problem:**
   - Agents need paid data per call; API owners have no simple way to sell to them on Masumi.
   - Buyers pay even when an answer is empty or stale.
   - Paying per call on chain costs about 1.2 to 1.5 ADA min-UTxO plus about 0.17 ADA fee, and waits for a block.
3. **Solution:** any read-only API, listed in minutes:
   - an OpenAPI link, or a base URL and a few example requests; JSON or text answers; API keys sealed for the gateway only;
   - ownership by one DNS TXT record (`_hirakumi.<host>`, DNS provider detected, its steps shown, "Ask Hirakumi how") and one wallet signature, re-checked every 6 hours;
   - a promise inferred from real test calls; text answers need a phrase the seller confirms;
   - **call packs** over x402: one payment for 100 calls; **credits only on pass**: a failing answer is a 422 and costs nothing;
   - **truthful health**: `/availability` answers 503 when the API breaks, so the Masumi registry shows Offline.
4. **Settlement, chosen per purchase:** direct (one tx to the seller, cheapest) or escrow in an Aiken contract (large pack, low uptime, new seller, or the buyer asks). In escrow the buyer signs an IOU per good answer; Close, Raise, Settle; the seller is paid only for signed calls; the buyer can always exit.
5. **Demo:** the video, or three screenshots: 402 with price, promise hash and settlement reasons; Cardanoscan lock and Settle; 422 with the API marked Down.
6. **How it fits Masumi:** "Masumi has, Hirakumi adds": registry token, registration from an OpenAPI link; `/availability`, answers from real test calls; escrow refund, a promise decides whether a result is submitted; MIP-004 hashes, the rule hash published before purchase; Sokosumi coworkers, the onboarding coworker and health alerts.
7. **Architecture:** gateway (Express on EC2: x402 packs, credits, escrow watcher, MIP-003, monitor), Masumi payment service, Postgres, Caddy, coworker, Next.js web app on Vercel, `pack_escrow` Aiken validator, `@x402/*` 2.26.0 on preprod with the hosted facilitator.
8. **Business model and roadmap:**
   - 3% fee on escrow packs (an output of the contract today); onboarding fee in Sokosumi credits.
   - Economics: about 0.014 ADA overhead per call at 100 calls, versus about 1.4 ADA per call paid on chain.
   - Next: reference-script UTxO for cheaper spends, contract audit, mainnet USDM, escrow as the default for new sellers.
- **Appendix:** edge cases handled: a replayed payment returns the same token; a race for the last credit has exactly one winner; a failed settlement leaves the token pending and unusable; SSRF guard on every outbound call; a buyer that demands escrow never gets a silent direct offer; on-chain evidence links (README).
