# Recording checklist

## T-60 min: environment
- [ ] EC2: `DEMO_MODE=1` in the gateway env, then `docker compose up -d gateway`. Check: `curl -s $PUBLIC_BASE_URL/a/$DEMO_API_ID/availability` → 200.
- [ ] Demo sellers: `curl -s $PRICE_API_URL/healthz` and `curl -s $MIKA_API_URL/healthz` → `{"ok":true,"modeStore":"memory"}`; mode reset on both: `curl -s -XPOST $MIKA_API_URL/admin/break -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"mode":"ok"}'`.
- [ ] Buyer wallet ≥ 10 tADA and ≥ 6 tUSDM (`USDM_PREPROD_ASSET`): check `https://preprod.cardanoscan.io/address/<buyer addr>`.
- [ ] Payment-service purchasing wallet ≥ 10 tADA and ≥ 3 escrow tUSDM (`MASUMI_ESCROW_UNIT`).
- [ ] `curl -s $PUBLIC_BASE_URL/a/api_eejiaioyqt/availability` answers available, and its registry token shows on preprod.cardanoscan.io.
- [ ] `rm agents/buyer/.tokens.json` so the take starts with a 402.
- [ ] Mika's FX Rates (https://mika.52-70-235-103.sslip.io) not yet listed, so the Sokosumi segment onboards it fresh; `MIKA_HIRAKUMI_CHALLENGE` ready to set once the ownership page shows the code.
- [ ] Escrow Close and Settle clips recorded, or the evidence txs (`2d296403...`, `cad54fc0...`) open on Cardanoscan.

## T-15 min: screen
- [ ] 1920×1080, browser zoom 125%, terminal font ≥ 18pt, dark theme, Do Not Disturb on, Slack/Discord closed.
- [ ] No secrets on screen: no `.env`, no `vercel env`, shell history cleared (`clear`), the ADMIN_TOKEN curl uses `$ADMIN_TOKEN`.
- [ ] Browser tabs, in order: (1) slides; (2) Sokosumi task; (3) Hirakumi web setup/review; (4) Hirakumi API overview; (5) the agent's registry token on preprod.cardanoscan.io (the masumi.network explorer does not index the payment-service 0.29 registry yet); (6) preprod.cardanoscan.io (buyer address); (7) payment-service escrow view.
- [ ] Terminal A (buyer): `REQUIRE_ESCROW=1 pnpm --filter @hirakumi/buyer run pack -- --api $MIKA_API_ID --escrow --op getRate --query from=USD --query to=EUR --calls 30 --interval 2000` typed but not run.
- [ ] Terminal B (seller): the break curl against `$MIKA_API_URL` with `{"mode":"stale"}` typed but not run.

## Takes
- [ ] Record each segment separately (OBS scene per segment), then edit to ≤ 3:00 total.
- [ ] Time-cuts, each shown with a small caption ("≈20 s later"): pack tx confirmation (20 to 60 s); Vercel redeploy for the X-Hirakumi-Verify header code; QA test calls; registry registration (about 1 min); registry Offline lag; escrow lock, Close and Settle waits.
- [ ] Show the Cardanoscan lock and Settle txs for at least 2 s each, with the tUSDM amounts and addresses visible.
- [ ] After recording: set mode `ok`, `DEMO_MODE` stays 1 until judging ends.

## Export
- [ ] Length ≤ 3:00 (check in the editor; 2:55 target).
- [ ] 1080p MP4, upload to YouTube **unlisted** and to the Drive folder; test both links in a private window.
