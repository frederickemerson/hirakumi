# Submission evidence

TOKEN2049 Origins, Cardano "Agentic Commerce" track. Everything runs on Cardano preprod. Transactions are checked on chain, URLs fetched live. Showcase listing: Mika's FX Rates, `api_7ebwqwczcw`.

| Requirement | Evidence | Status |
|---|---|---|
| Working prototype on Cardano preprod | Gateway https://52-70-235-103.sslip.io/healthz, web app https://hirakumi.vercel.app; every transaction below is on preprod | Verified |
| Public GitHub repo with documentation and license | https://github.com/frederickemerson/hirakumi, [`README.md`](../../README.md), `LICENSE` (MIT) | Verified |
| Live URLs | Web app https://hirakumi.vercel.app; try pages https://hirakumi.vercel.app/p/api_eejiaioyqt/try and https://hirakumi.vercel.app/p/api_7ebwqwczcw/try; demo sellers https://price.52-70-235-103.sslip.io/openapi.json and https://mika.52-70-235-103.sslip.io/openapi.json | Verified |
| Write-up | [`docs/submission/writeup.md`](writeup.md) | Verified |
| Demo video and slides | Linked in the submission form | In the submission form |
| Agent registered on Masumi | Mika agent identifier [`67ab0c92...d436d11f5000000`](https://preprod.cardanoscan.io/token/67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10e52a7b4eff23a80d7da2d3ca490c28d7ea8eec153805b61d436d11f5000000), registry mint [8f04206b...](https://preprod.cardanoscan.io/transaction/8f04206b27e66266d61f22423c01447cad88582fb9c7fd7b96b7ac1f728e602a); on-chain `api_base_url` is the MIP-003 agent below | Verified |
| Deployed MIP-003 agent | https://52-70-235-103.sslip.io/a/api_7ebwqwczcw/availability answers `available`; [`/input_schema`](https://52-70-235-103.sslip.io/a/api_7ebwqwczcw/input_schema) 200 | Verified |
| x402 payment offer | `GET /a/api_7ebwqwczcw/x/convertAmount?from=USD&to=EUR&amount=100` answers 402 with the pack (100 calls, 2 tUSDM) and the promise hash; `POST /a/api_7ebwqwczcw/packs/pk_jsus5yvzmq` answers the x402 v2 offer: `exact`, `cardano:preprod`, 2 000 000 micros tUSDM, `payTo` the seller | Verified |
| Agent paid for the Mika agent | Pack lock [07d1bc1d...](https://preprod.cardanoscan.io/transaction/07d1bc1d7f51dc41e17ea4bc179fe94f06e5524b51ce0de3f03321679728605b): 2 tUSDM into the escrow script; the datum names the Mika seller and promise [`sha256:e05d0453...`](https://52-70-235-103.sslip.io/r/sha256:e05d0453a3c5b88266a67ccfdab4906219deea4d9439318ac1d91cd1043d5de0) | Verified |
| Paid calls served and checked | 3 paid calls, 3 kept the promise; the buyer signed receipts for 2 | Verified |
| Mika seller received payment | Close [faae6b22...](https://preprod.cardanoscan.io/transaction/faae6b22dca816fd91f8ed5d7a639db8f2c2d8325c5fa32457820aa3354cf6ac), Settle [d64f7906...](https://preprod.cardanoscan.io/transaction/d64f790605dbda025dbf92272c0546ea0fe02ab6f10984516df064da0fa4fdaa): 38 800 micros tUSDM to the seller for 2 signed calls, 1 200 Hirakumi fee (3%), 1 960 000 back to the buyer | Verified |
| Hybrid settlement on the production gateway | Buyer asks for escrow: lock [8b648494...](https://preprod.cardanoscan.io/transaction/8b6484943561dad5f8a297e07fb217c5ee009e018c9c618ad711691bbd775032), Close [2d296403...](https://preprod.cardanoscan.io/transaction/2d29640399bd266b9e2a7bfcd5d382443b97fd0a884b987e5997f3989136d4e4), Settle [cad54fc0...](https://preprod.cardanoscan.io/transaction/cad54fc01cdd98f04e94f32113f5d3368f462c734beb37d66fee54980180093d) (seller 58 200, fee 1 800, buyer 1 940 000 micros). Direct chosen ("small pack, proven seller"): [200a86c0...](https://preprod.cardanoscan.io/transaction/200a86c03d0936de6f15f37f09e7931ca3fad96ce20b22728d9c731bf3975e7b), 1 tUSDM to the seller | Verified |
| Escrow contract paths | Close at 1, Raise to 3 [dc051596...](https://preprod.cardanoscan.io/transaction/dc051596cf21c7c5dececb29c3fbb914c3d945b4a308c40fc141ac92bf78bfdb), Settle [6ba1bf17...](https://preprod.cardanoscan.io/transaction/6ba1bf17c9976f876bcc0295ae523f8c1f2c2051ade0bf283e83b4843d4eaf37); buyer exit with no receipt, everything returned [f33c1788...](https://preprod.cardanoscan.io/transaction/f33c1788c36afdd09fee5204fe35ed1102a2fe117e3a87fa08092211f8dbb6ea) | Verified |
| Direct x402 packs paid to sellers | [43844e7b...](https://preprod.cardanoscan.io/transaction/43844e7b86c35e680805d5916cd38743462fbcf4cbd1db580d0faad8936e6a09) 2 tUSDM (settled in 16.5 s), [9d1b37be...](https://preprod.cardanoscan.io/transaction/9d1b37bee0227ae56217699b15ddea5cf7d549f2bd4dae0e734f304c55c7b9eb) 2 tUSDM to the API owner's wallet (settled in 9.4 s) | Verified |
| Masumi escrow job paid out | Result [f60d247d...](https://preprod.cardanoscan.io/transaction/f60d247d30e075f69cd5b876c49df45a4aadf68fa7fc67d0a00c60edb2321fd2), collection [6fd28bb9...](https://preprod.cardanoscan.io/transaction/6fd28bb92094e8fd5e9332d644c8fd7fd6f2c4572847ded32bcb22df9a46ae4a): 2 Masumi tUSDM to the seller ("Live Crypto Prices") | Verified |
| Masumi escrow job refunded on a broken promise | Stale data, no result submitted, refund [8487fcc1...](https://preprod.cardanoscan.io/transaction/8487fcc1ea74df73a170c937215a59ee2b16f2be418ccd879f67b4bf38b5d9c0) | Verified |

Escrow script address: [`addr_test1wq3a6jmeshhdn8wnzgrgtxzgsz26w8ggnupzty69sa2lwqs3jsjn3`](https://preprod.cardanoscan.io/address/addr_test1wq3a6jmeshhdn8wnzgrgtxzgsz26w8ggnupzty69sa2lwqs3jsjn3).

## Masumi track identifiers

| Item | Value |
|---|---|
| Deployed agent URL (MIP-003) | https://52-70-235-103.sslip.io/a/api_eejiaioyqt (`/availability`, `/input_schema`, `/start_job`, `/status`) |
| Sokosumi coworker ID | `01a11066-4529-71cf-b1b1-21a3e47a597a` (slug `hirakumi`) |
| Completed Sokosumi task ID | `01a11067-1d95-75b8-9d9f-d9487812cdd9` ("Put my API on the agent market") |
| Masumi registry entry ("Live Crypto Prices") | [`67ab0c92...b40f30000000`](https://preprod.cardanoscan.io/token/67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b102dd0a53732b963d1737a246197bcfa58a631686ec49d769ad7b40f30000000), mint [4a1b77aa...](https://preprod.cardanoscan.io/transaction/4a1b77aa7ae49df15e10ade1e920bd22c7d5b3ed204e21e9a5742e00cdf5cac2) |
| Masumi registry entry (Mika's FX Rates) | [`67ab0c92...d436d11f5000000`](https://preprod.cardanoscan.io/token/67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10e52a7b4eff23a80d7da2d3ca490c28d7ea8eec153805b61d436d11f5000000), mint [8f04206b...](https://preprod.cardanoscan.io/transaction/8f04206b27e66266d61f22423c01447cad88582fb9c7fd7b96b7ac1f728e602a) |
| Registry policy | `67ab0c92...`, the registry of Masumi payment service 0.29; tokens are shown on Cardanoscan |
| Masumi tUSDM unit | `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d` |

## Links

- Repo: https://github.com/frederickemerson/hirakumi
- Write-up: [writeup.md](writeup.md)
- Web app: https://hirakumi.vercel.app
