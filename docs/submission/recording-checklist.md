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
- [ ] Browser tabs, in order: (1) slides; (2) Sokosumi task; (3) Hirakumi web setup/review; (4) Hirakumi API overview; (5) the agent's registry token on preprod.cardanoscan.io (the masumi.network explorer does not index the payment-service 0.29 registry yet); (6) preprod.cardanoscan.io (buyer address); (7) payment-service escrow view.
- [ ] Terminal A (buyer): `pnpm --filter @hirakumi/buyer run pack -- --api $DEMO_API_ID --calls 30 --interval 2000` typed but not run.
- [ ] Terminal B (seller): the break curl typed but not run.

## Takes
- [ ] Record each segment separately (OBS scene per segment), then edit to ≤ 3:00 total.
- [ ] Time-cuts, each shown with a small caption ("≈20 s later"): pack tx confirmation (20–60s); Vercel redeploy for the challenge file; QA test calls; registry registration (about 1 min); registry Offline lag; escrow lock and refund wait.
- [ ] Show the Cardanoscan pack tx for ≥ 2s with the tUSDM amount and the seller address visible.
- [ ] After recording: set mode `ok`, `DEMO_MODE` stays 1 until judging ends.

## Export
- [ ] Length ≤ 3:00 (check in the editor; 2:55 target).
- [ ] 1080p MP4, upload to YouTube **unlisted** and to the Drive folder; test both links in a private window.
