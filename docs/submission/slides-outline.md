# Hirakumi slides (8 slides + appendix)

1. **Title:** "Hirakumi (開く, to open): any API, sold to AI agents in three minutes. Buyers only pay for answers that pass." Team names, TOKEN2049 Origins, Cardano Agentic Commerce track.
2. **Problem:**
   - Agents need paid data per call; API sellers have no way to reach them on Masumi without building an agent.
   - Buyers pay even when a response is broken or stale.
   - Per-call on-chain payment on Cardano costs about 1.2–1.5 ADA min-UTxO plus about 0.17 ADA fee, with a 20–60s confirmation.
3. **Solution:** A Sokosumi coworker that turns an OpenAPI link into a Masumi-registered agent:
   - confirm endpoints, prove ownership (a code in the OpenAPI file + one wallet signature), approve a price and a plain-English promise, Publish;
   - **call packs** over x402: one tUSDM payment straight to the seller for 100 calls;
   - **credits used only on pass**: a failing answer returns 422 and costs nothing;
   - **truthful health**: `/availability` returns 503 when the API is down, so the registry shows Offline.
4. **Demo:** the video (embedded) or 3 screenshots: 402 with price and promise hash → Cardanoscan pack tx → 422 "credits unchanged" + Down.
5. **How it fits Masumi:** table "Masumi already has → Hirakumi adds":
   registry NFT → one-step registration from OpenAPI; `/availability` health check → answers from real test calls; escrow auto-refund → an acceptance rule decides whether a result is submitted; MIP-004 hashes → rule hash published before purchase; Sokosumi coworkers → the onboarding coworker plus health alerts.
6. **Architecture:** gateway (Express on EC2: x402 packs, credits, MIP-003, monitor) · Masumi payment service (registry, escrow) · Postgres · Caddy · coworker · Next.js dashboard on Vercel · `@x402/*` 2.26.0 on Cardano preprod with the hosted facilitator.
7. **Business model:**
   - Onboarding fee: billed in Sokosumi credits, about $10–20 per API.
   - Take rate on packs: 3% (second output if x402 supports it, else billed monthly).
   - Pro: faster probes, analytics, a scored badge.
   - Call-pack economics: about 1.4 ADA overhead once per pack = about 0.014 ADA per call at 100 calls, versus about 1.4 ADA per call if every call paid on-chain (100× cheaper per call). Non-custodial: pack payments go straight to the seller.
8. **Roadmap:** packs paid into escrow (buyer protection if a seller disappears); public QA and pricing agents; drift detection; mainnet after the track; DNS ownership; upstream auth.
- **Appendix:** edge cases we handle (replayed payment → same token; race for last credit → exactly one wins; settlement fails → token stays pending and unusable; SSRF guard; 15s upstream timeout).
