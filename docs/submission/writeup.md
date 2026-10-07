# Hirakumi: monetize any API in under 3 minutes.

## Problem

AI agents are becoming customers. They need live data such as prices, exchange rates and weather, and they buy it one answer at a time. Enterprises and institutions already run a lot of good APIs with exactly that data, but none of them can sell to an agent. To sell on Masumi today, an API owner has to wrap the API in an LLM agent, run a payment node, register it, handle payments and refunds, and keep its status honest all day. Inside a large organization that is a real project: the code sits in siloed codebases owned by different teams, and every change to a production API needs review, so the data never gets sold. Hirakumi doesn't touch their code: ownership is proven with one DNS record and the API stays exactly as it is. Even then there is no trust layer: agents pay even when an answer is empty or hours old, because the seller's own code decides whether an answer was good. Paying on chain for every answer doesn't work either, since each Cardano payment costs about 40 cents for an answer worth a fraction of a cent. An AI can write you an agent, but it can't be its own trust layer.

## Technical approach

Hirakumi does all of that setup for you, from one link, and adds the trust layer Masumi doesn't have: every answer is checked before anyone pays for it. It is built on Cardano's tools for AI agents. The seller pastes an API link, proves it is theirs with one DNS TXT record and signs once with a Cardano wallet; with UTXOS, an email or Google login opens a wallet the seller owns. If the API needs a key, it is sealed so only our gateway can use it, and a front door on Caddy makes the API's own hostname answer through Hirakumi, so the paid API isn't free elsewhere. Hirakumi test-calls the API and sets a public promise that every good answer must keep, then registers the API as an agent on Masumi, where agents find services and get refunds per job. Agents pay once with x402 on Cardano for a pack of 100 answers in USDM. Every answer goes through our gateway and is checked against the promise: a good answer uses one credit, a bad one is free, and an API that breaks is marked Down and stops selling. For large or risky packs the money waits in our Aiken smart contract, the safe: the agent signs a receipt only for good answers, and the contract pays the seller for those, Hirakumi 3%, and returns the rest. Nobody can take more than the agent agreed to, not even us. Our Sokosumi coworker allows the same functionality inside sokosumi. Blockfrost lets us read the chain, the gateway runs on AWS and the website on Vercel. Everything is live on Cardano preprod, with real packs paid, used and settled on chain.

## Real-world use cases

Any API can be sold to agents in a line of code: crypto prices and exchange rates for trading agents, weather for logistics and travel agents, search and company data for research agents, translation, image generation or booking for assistant agents, or a niche dataset a developer already hosts. A trading agent can buy 100 fresh price quotes for $2 and pay only for the ones that arrive on time. Cardano holds and settles the money for every pack, while the answers themselves flow at web speed, in about 0.3 seconds each. One Cardano transaction pays for 100 answers, so even sub-cent answers are worth selling, and the gateway scales like a normal web app. Revenue comes from a 3% fee, paid out by the Cardano contract only on good answers.

## Proof it works

Mika's FX Rates, a third-party API, went through the full lifecycle on Cardano preprod on 7 Oct 2026. Every transaction below is on chain.

| Step | Transaction |
|---|---|
| Registered on Masumi (registry mint) | [8f04206b...](https://preprod.cardanoscan.io/transaction/8f04206b27e66266d61f22423c01447cad88582fb9c7fd7b96b7ac1f728e602a) |
| Agent paid for a pack of 100 calls: 2 tUSDM locked in the safe | [07d1bc1d...](https://preprod.cardanoscan.io/transaction/07d1bc1d7f51dc41e17ea4bc179fe94f06e5524b51ce0de3f03321679728605b) |
| Paid calls through the gateway, each checked against the promise | 3 calls, 3 kept the promise |
| Close at 2 signed receipts | [faae6b22...](https://preprod.cardanoscan.io/transaction/faae6b22dca816fd91f8ed5d7a639db8f2c2d8325c5fa32457820aa3354cf6ac) |
| Settle: the seller is paid for the signed answers, Hirakumi 3%, the agent gets the rest back | [d64f7906...](https://preprod.cardanoscan.io/transaction/d64f790605dbda025dbf92272c0546ea0fe02ab6f10984516df064da0fa4fdaa) |

More evidence, including direct packs, a Raise, a buyer exit and Masumi jobs with a payout and a refund: [README, On-chain evidence](../../README.md#on-chain-evidence-cardano-preprod) and [Submission evidence](submission-checklist.md).

## Links

- Repo: https://github.com/frederickemerson/hirakumi
- Web app: https://hirakumi.vercel.app
- Buy a real pack in your browser: https://hirakumi.vercel.app/p/api_eejiaioyqt/try
- Gateway: https://52-70-235-103.sslip.io/healthz
