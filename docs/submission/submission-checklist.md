# Submission checklist. Deadline 7 Oct 2026 23:59 SGT; our target 21:00 SGT

## Track requirements (official brief)
- [ ] Working prototype on Cardano preprod
- [ ] Open-source repo with docs: GitHub repo **public**, `README.md` file lists per technology (Task 16 path check passes), MIT license
- [ ] Live URL(s): dashboard https://hirakumi.vercel.app, gateway https://52-70-235-103.sslip.io, demo API https://price.52-70-235-103.sslip.io, try it live https://hirakumi.vercel.app/p/api_eejiaioyqt/try (all 200 from a private window)
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

## Masumi track evidence (https://www.masumi.network/token2049/submission)
All on Cardano preprod. Explorer: https://preprod.cardanoscan.io

- Deployed agent URL (MIP-003): https://52-70-235-103.sslip.io/a/api_eejiaioyqt (`/availability`, `/input_schema`, `/start_job`, `/status`)
- Sokosumi Coworker ID: `01a11066-4529-71cf-b1b1-21a3e47a597a` (slug `hirakumi`, vendor `01a11066-2d75-768f-a3d2-807ce41e35d7`)
- Completed Sokosumi Task ID: `01a11067-1d95-75b8-9d9f-d9487812cdd9` ("Put my API on the agent market", status COMPLETED)
- Masumi registry entry (agent identifier): `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1045366ca66c83ac363d53190157962fbea7b5751c6940f81251914ab5000000`
  - Registry policy `67ab0c92…` is the registry used by payment-service 0.29; the masumi.network agent explorer currently indexes only the older policy `7e8bdaf2…`, so show the token on Cardanoscan: https://preprod.cardanoscan.io/token/67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1045366ca66c83ac363d53190157962fbea7b5751c6940f81251914ab5000000
  - Registration (mint) tx: `84deabe2ba2ad19f4fba5e421805e49c4863ea63047937a2abcf5d8b6eaa3c32`
- Seller (node selling wallet): `addr_test1qrzww9v9n7aghkeuzput8ccjd3kt4p6kz8gfa58899meg3vf6m9s83svmhkpavx3gjhx5t82x8qtt02lsawaj8nerdwsnxwecc`
- Escrow contract: `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`
- Token unit (Masumi tUSDM): `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`

### Escrow job that kept its promise (6 Oct 2026)
- Job `job_jeabut75wv`, purchase `cmuwhphm300101op0gvur9kgw`, 2 tUSDM, input `{"symbol":"ADA"}`
- Payment (lock) tx: `e88f05f6a46144e0f3f9a5c4eae8de3ae7076aa5ec07fc35c35373179177fed9` (09:44:03 UTC)
- Result submitted by seller tx: `f60d247d30e075f69cd5b876c49df45a4aadf68fa7fc67d0a00c60edb2321fd2` (09:45:36 UTC); buyer verified the MIP-004 output hash
- Seller collection tx: _pending (after unlock time)_
- Net amount to seller: _fill from the collection tx_

### Escrow job that broke its promise → automatic refund
- Job `job_zfj73wqatd`, purchase `cmuwhthj3001h1op0hwc92skw`, 2 tUSDM; demo API switched to stale data
- Payment (lock) tx: `5ffa09a7a08d8931648801a84f311f4c569d99c1528650c81a2a5fcd8734a649` (09:47:22 UTC)
- Gateway verdict: promise not met (`/timestamp is older than 900s`), no result submitted
- Refund tx: _pending (refund unlocks after 10:05:25 UTC)_

### x402 call packs
- First pack: tx `43844e7b86c35e680805d5916cd38743462fbcf4cbd1db580d0faad8936e6a09`, settled in 16.5 s, seller received exactly 2.00 tUSDM
- Demo pack for the try page: tx `9d1b37bee0227ae56217699b15ddea5cf7d549f2bd4dae0e734f304c55c7b9eb`, settled in 9.4 s, paid straight to the API owner's wallet
