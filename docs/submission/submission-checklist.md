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
