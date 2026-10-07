# Submission checklist

Deadline: 7 Oct 2026, 23:59 SGT.

## Track requirements (official brief)
- [ ] Working prototype on Cardano preprod
- [ ] Public GitHub repo with documentation: https://github.com/frederickemerson/hirakumi (`README.md`, MIT license)
- [ ] Live URLs, each 200 from a private window: web https://hirakumi.vercel.app, gateway https://52-70-235-103.sslip.io, demo sellers https://price.52-70-235-103.sslip.io and https://mika.52-70-235-103.sslip.io, try page https://hirakumi.vercel.app/p/api_eejiaioyqt/try
- [ ] Demo video, 3:00 or less (YouTube unlisted), link opens in a private window
- [ ] Slides (Google Drive, "Anyone with the link: Viewer")
- [ ] Write-up: problem, technical approach with tools, frameworks and Cardano infrastructure, deployment and scaling (`docs/submission/writeup.md`)

## Requirement check (7 Oct 2026, 13:55 UTC)

Transactions checked on Blockfrost preprod (`/txs/<hash>/utxos`), listing data read from the production database, URLs fetched live. Showcase listing: Mika's FX Rates, `api_7ebwqwczcw`.

| Requirement | Evidence | Verified |
|---|---|---|
| Working prototype on Cardano preprod | Gateway https://52-70-235-103.sslip.io/healthz 200; web https://hirakumi.vercel.app 200; every tx below is on preprod | yes |
| Public GitHub repo with docs and license | https://github.com/frederickemerson/hirakumi (public), `README.md`, `LICENSE` | yes |
| Live URLs | Web 200; gateway 200; try pages https://hirakumi.vercel.app/p/api_eejiaioyqt/try and https://hirakumi.vercel.app/p/api_7ebwqwczcw/try 200; seller OpenAPI files at price, mika and fx.patricksteveharrison.com 200 (their roots answer 404 by design) | yes |
| Agent registered on Masumi | Mika agent identifier `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10e52a7b4eff23a80d7da2d3ca490c28d7ea8eec153805b61d436d11f5000000`, mint [8f04206b...](https://preprod.cardanoscan.io/transaction/8f04206b27e66266d61f22423c01447cad88582fb9c7fd7b96b7ac1f728e602a) (10:51 UTC, metadata `api_base_url` is the gateway URL below). The masumi.network explorer does not index policy `67ab0c92...`, so link the [token on Cardanoscan](https://preprod.cardanoscan.io/token/67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10e52a7b4eff23a80d7da2d3ca490c28d7ea8eec153805b61d436d11f5000000) | yes |
| Deployed MIP-003 agent | https://52-70-235-103.sslip.io/a/api_7ebwqwczcw/availability 200 `available`; `/input_schema` 200; `/status` without an id answers 404 `JOB_NOT_FOUND` | yes |
| x402 payment offer | Paid route `/a/api_7ebwqwczcw/x/convertAmount` answers 402 with the pack; `POST /a/api_7ebwqwczcw/packs/pk_jsus5yvzmq` answers x402 v2 402: `exact`, `cardano:preprod`, 2 000 000 tUSDM, `payTo` the seller `addr_test1qzrz6vvv...dwlc45` | yes |
| Buyer paid for the Mika agent | Pack lock [07d1bc1d...](https://preprod.cardanoscan.io/transaction/07d1bc1d7f51dc41e17ea4bc179fe94f06e5524b51ce0de3f03321679728605b): 2 tUSDM into the escrow script, datum names the Mika seller and promise `sha256:e05d0453...` | yes |
| Paid calls served | 3 credit calls, 3 passed, 0 failed (`calls` table); buyer signed IOUs for 2 | yes |
| Mika seller received payment | No. Channel `76b479a5...` is Open: no Close or Settle tx, the lock output is unspent, and the seller address has only its funding tx. Settle at 2 signed calls would pay it 38 800 micros tUSDM | no |
| Sellers received payments (earlier listings) | Direct packs [43844e7b...](https://preprod.cardanoscan.io/transaction/43844e7b86c35e680805d5916cd38743462fbcf4cbd1db580d0faad8936e6a09) 2 tUSDM, [9d1b37be...](https://preprod.cardanoscan.io/transaction/9d1b37bee0227ae56217699b15ddea5cf7d549f2bd4dae0e734f304c55c7b9eb) 2 tUSDM, [200a86c0...](https://preprod.cardanoscan.io/transaction/200a86c03d0936de6f15f37f09e7931ca3fad96ce20b22728d9c731bf3975e7b) 1 tUSDM; escrow lock [8b648494...](https://preprod.cardanoscan.io/transaction/8b6484943561dad5f8a297e07fb217c5ee009e018c9c618ad711691bbd775032), Close [2d296403...](https://preprod.cardanoscan.io/transaction/2d29640399bd266b9e2a7bfcd5d382443b97fd0a884b987e5997f3989136d4e4), Settle [cad54fc0...](https://preprod.cardanoscan.io/transaction/cad54fc01cdd98f04e94f32113f5d3368f462c734beb37d66fee54980180093d) (seller 58 200, fee 1 800, buyer 1 940 000 micros) | yes |
| Masumi escrow job paid out | Result [f60d247d...](https://preprod.cardanoscan.io/transaction/f60d247d30e075f69cd5b876c49df45a4aadf68fa7fc67d0a00c60edb2321fd2), collection [6fd28bb9...](https://preprod.cardanoscan.io/transaction/6fd28bb92094e8fd5e9332d644c8fd7fd6f2c4572847ded32bcb22df9a46ae4a): 2 Masumi tUSDM to the seller. No Masumi jobs exist for the Mika listings | yes (not on Mika) |
| Earlier Mika listing `api_cke2nitg7f` | Mint [4e6f7040...](https://preprod.cardanoscan.io/transaction/4e6f7040fade713187f29d52a68dfa6661ea3703de60201dc6bac71082c5dac0); pack lock [7119fc43...](https://preprod.cardanoscan.io/transaction/7119fc43e2a474f0d9930f80ce83a1b152fdc3ccf5feca12ea48f71213b9eb14) 2 tUSDM, 1 passed call, no IOU, still Open | yes |
| Demo video (3:00 or less) | Link not filled in below | no |
| Slides | Link not filled in below | no |
| Write-up | `docs/submission/writeup.md` | yes |

## Links
- Repo: https://github.com/frederickemerson/hirakumi
- Write-up: https://github.com/frederickemerson/hirakumi/blob/main/docs/submission/writeup.md
- Live: https://hirakumi.vercel.app
- Video: ______
- Slides: ______

## Order of submission
1. [ ] Submit to the main track (form on the track page): repo, live URL, video, slides, write-up.
2. [ ] Add the Cardano "Agentic Commerce" track to the same submission.
3. [ ] Screenshot each confirmation page.
4. [ ] Re-open the submission and check every link.

## Final checks
- [ ] `pnpm typecheck`, `pnpm test` and `aiken check` green on `main`
- [ ] Gateway has applied migrations through 0015: `select name from schema_migrations order by name desc limit 1`
- [ ] No secrets in the repo: `git log -p | grep -E 'MNEMONIC=|ADMIN_TOKEN=|PAYMENT_SERVICE_TOKEN=|PRIVATE_KEY='` shows no values
- [ ] `DEMO_MODE=1` stays on and both demo sellers are in mode `ok` during judging
- [ ] Buyer and purchasing wallets keep at least 10 tADA so judges can re-run the buyer

## Masumi track evidence (https://www.masumi.network/token2049/submission)
All on Cardano preprod. Explorer: https://preprod.cardanoscan.io

- Deployed agent URL (MIP-003): https://52-70-235-103.sslip.io/a/api_eejiaioyqt (`/availability`, `/input_schema`, `/start_job`, `/status`)
- Sokosumi Coworker ID: `01a11066-4529-71cf-b1b1-21a3e47a597a` (slug `hirakumi`, vendor `01a11066-2d75-768f-a3d2-807ce41e35d7`)
- Completed Sokosumi Task ID: `01a11067-1d95-75b8-9d9f-d9487812cdd9` ("Put my API on the agent market", status COMPLETED)
- Masumi registry entry, current ("Live Crypto Prices"): `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b102dd0a53732b963d1737a246197bcfa58a631686ec49d769ad7b40f30000000`, mint tx `4a1b77aa7ae49df15e10ade1e920bd22c7d5b3ed204e21e9a5742e00cdf5cac2`
- Masumi registry entry, first registration ("Test", used by the escrow jobs below): `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1045366ca66c83ac363d53190157962fbea7b5751c6940f81251914ab5000000`
  - Registry policy `67ab0c92…` is the registry used by payment-service 0.29; the masumi.network agent explorer currently indexes only the older policy `7e8bdaf2…`, so show the token on Cardanoscan: https://preprod.cardanoscan.io/token/67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1045366ca66c83ac363d53190157962fbea7b5751c6940f81251914ab5000000
  - Registration (mint) tx: `84deabe2ba2ad19f4fba5e421805e49c4863ea63047937a2abcf5d8b6eaa3c32`
- Seller (node selling wallet): `addr_test1qrzww9v9n7aghkeuzput8ccjd3kt4p6kz8gfa58899meg3vf6m9s83svmhkpavx3gjhx5t82x8qtt02lsawaj8nerdwsnxwecc`
- Escrow contract: `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`
- Token unit (Masumi tUSDM): `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`

### Escrow job that kept its promise (6 Oct 2026)
- Job `job_jeabut75wv`, purchase `cmuwhphm300101op0gvur9kgw`, 2 tUSDM, input `{"symbol":"ADA"}`
- Payment (lock) tx: `e88f05f6a46144e0f3f9a5c4eae8de3ae7076aa5ec07fc35c35373179177fed9` (09:44:03 UTC)
- Result submitted by seller tx: `f60d247d30e075f69cd5b876c49df45a4aadf68fa7fc67d0a00c60edb2321fd2` (09:45:36 UTC); buyer verified the MIP-004 output hash
- Seller collection tx: `6fd28bb92094e8fd5e9332d644c8fd7fd6f2c4572847ded32bcb22df9a46ae4a` (10:29 UTC): spends the escrow lock and pays the seller's verified address (`sellerReturnAddress`, `addr_test1qq8ag9…`, the API owner's own wallet)
- Net amount to seller: 2.00 tUSDM (unit `16a55b2a…0014df10745553444d`), no fee taken

### Escrow job that broke its promise → automatic refund
- Job `job_zfj73wqatd`, purchase `cmuwhthj3001h1op0hwc92skw`, 2 tUSDM; demo API switched to stale data
- Payment (lock) tx: `5ffa09a7a08d8931648801a84f311f4c569d99c1528650c81a2a5fcd8734a649` (09:47:22 UTC)
- Gateway verdict: promise not met (`/timestamp is older than 900s`), no result submitted
- Refund tx: `8487fcc1ea74df73a170c937215a59ee2b16f2be418ccd879f67b4bf38b5d9c0` (10:16 UTC): spends the escrow lock and returns the 2 tUSDM to the buyer side (the purchasing hot wallet's configured collection address `addr_test1qp88r23…`; in this demo buyer and seller share one payment-service node)

### x402 call packs
- First pack: tx `43844e7b86c35e680805d5916cd38743462fbcf4cbd1db580d0faad8936e6a09`, settled in 16.5 s, seller received exactly 2.00 tUSDM
- Demo pack for the try page: tx `9d1b37bee0227ae56217699b15ddea5cf7d549f2bd4dae0e734f304c55c7b9eb`, settled in 9.4 s, paid straight to the API owner's wallet

### Pack escrow channel (contracts/pack-escrow, script `addr_test1wq3a6jmeshhdn8wnzgrgtxzgsz26w8ggnupzty69sa2lwqs3jsjn3`)
- Current validator, re-run 6 Oct 2026 after the security fixes:
  - Run 1: lock `cff96ba11b4cec9b079d343c4afc0b089a8b1df6f2561b1a8ee6ec98851e4946` (x402 `script` through the hosted facilitator) → Close{1} by the closer `bf12de92cd303edc81ea115f8d81cddf3fc3d17afead064557b5c8e52f0bc383` → Raise{3} `dc051596cf21c7c5dececb29c3fbb914c3d945b4a308c40fc141ac92bf78bfdb` → Settle `6ba1bf17c9976f876bcc0295ae523f8c1f2c2051ade0bf283e83b4843d4eaf37` (seller 58 200, fee 1 800, buyer 1 940 000 micros tUSDM; every payout tagged with the channel id; Settle fee 0.43 ADA)
  - Run 2 (buyer exits with no IOU): lock `619e1f4e18de578acf86da69bed1af4af06423ba9654aac1876b85e58e829a9c` → Close{0} signed by the buyer `f35ebca354aa1315467076830f11c33328700de2bbaf296f2217389a692df554` → Settle `f33c1788c36afdd09fee5204fe35ed1102a2fe117e3a87fa08092211f8dbb6ea` (all 2 000 000 micros back to the buyer)
  - Gateway + buyer agent run (fixed gateway, `PACK_MODE=escrow`, ChannelWatcher as closer): lock `77d2dc3c233f90e5d02345fedf9b02086dc002156ab16d6166c4ed241fabe2ea` → 3 paid calls with IOUs 1..3 → buyer close request → watcher Close{3} `d6e0dd711f16c9f73547b5f41b5799b9fe7b15682ca84c7bf99ccd0bdeeede9c` → watcher Settle `47908d37ab82418ef60e7b5b9b9022fd1f252bbd77549b616523a3baf7866bc2` (seller 58 200, fee 1 800, buyer 1 940 000 micros tUSDM)
  - Hybrid settlement (`PACK_MODE=hybrid`, 7 Oct 2026, local gateway, hosted facilitator, Hirakumi operator as closer, Hirakumi treasury as fee address): escrow chosen ("large pack, new seller"): lock `7da0cfaeb6981b8c1f411697fee2fb4207d70fcffb6fd4b612f5d2f89329999e` → 3 paid calls with IOUs 1..3 → watcher Close{3} `118e08c16618c75b3d0d645371dacb7319f826b07bb791566d49c2d13dd3d1de` → watcher Settle `ebe5d021777d05084fe342c42c843e8d233d0d97ff6d3a01a7433978d5ca81a2` (seller 58 200, fee 1 800, buyer 1 940 000 micros tUSDM). Direct chosen ("small pack, proven seller"): 1 tUSDM to the seller `200a86c03d0936de6f15f37f09e7931ca3fad96ce20b22728d9c731bf3975e7b`, 2 paid calls.
  - Buyer demands escrow on production (`X-Hirakumi-Settlement: escrow`, buyer agent with `REQUIRE_ESCROW=1`, EC2 gateway in hybrid, 7 Oct 2026): settlement "buyer asked for escrow, large pack, new seller": lock `8b6484943561dad5f8a297e07fb217c5ee009e018c9c618ad711691bbd775032` → 3 paid calls, each checked locally and signed (IOUs 1..3) → Close{3} `2d29640399bd266b9e2a7bfcd5d382443b97fd0a884b987e5997f3989136d4e4` → Settle `cad54fc01cdd98f04e94f32113f5d3368f462c734beb37d66fee54980180093d` (seller 58 200, Hirakumi treasury 1 800, buyer refund 1 940 000 micros tUSDM).
- Evidence below was produced with the previous validator version (script `addr_test1wqwqw68rgnnd7z99300njyhkez24yzwx660vxmu0wzpzsscrga9pa`). The security fixes of 6 Oct 2026 changed the validator and its address; the runs above repeat them against the current address.
- Run 1: lock `2e5a2d0e13dd634e9946eef0c83ff322dcb8614f847cffd9f693fd982f78c5d4` (x402 `script` through the hosted facilitator) → Close{1} `b6b853e94dc3860acea21872b231e913962bbd9090ceee60c09c04ff0aa9ce13` → Raise{3} `bffe6067c246017d041f4c0f79204c3bc2b31ab443ab1716c9006a81c25701c5` → Settle `51c249eaf4048cf2628554246f78642fe2b96738f6a3b2100d6c07f92aecb1f8` (seller 58 200, fee 1 800, buyer 1 940 000 micros tUSDM; every payout tagged with the channel id)
- Run 2 (buyer exits with no IOU): lock `527793c53cebb0f9bb52c565f3cd6902a3bd6d41576e7f3c232e2736b15be940` → Close{0} by the buyer `4df338a3f7dc07d1259cace23ec674c7619fe209101b3b55ea8650d935f90c23` → Settle `dce6cf35de5554e4477e2105b6925a57691ecbbffaea9c155bd7a3f44dec059f` (everything back to the buyer)
- Gateway + buyer agent run: lock `013b170a9b49047c3f6f9e6a88a3b200986bce855e9949cc283b628570d06995` → watcher Close{3} `bd34fe3a8bdc8fea9d37aade8a525addf1eff47c3ff987d54f253bcbbe21d549` → watcher Settle `18f943db059ce79c5e888305564797c8eb51da92efc6210e18430fb53cfe59ff` (seller 60 000, buyer 1 940 000)
