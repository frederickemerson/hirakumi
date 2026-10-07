# Hirakumi: monetize any API in under 3 minutes.

## Problem

Enterprises and institutions sit on lots of good APIs. But making one payable by AI agents means new code inside big, siloed codebases: billing, wallets, refunds and an agent wrapper, each change waiting on security review and the next release. The average enterprise runs 897 applications with only 29% connected, and IT spends 39% of its time on custom integrations (MuleSoft, 2025). So most of these APIs never earn a cent from agents. Even on Masumi, Cardano's marketplace for AI agents, buyers have no trust layer: they pay even for empty or stale answers, because the seller grades its own work. An AI can write you an agent, but it can't be its own trust layer.

## Technical approach

Hirakumi does all of that from one link, with no change to the seller's code, and adds the trust layer: every answer is checked before anyone pays for it. Sellers sign in with Google or email through UTXOS, no wallet needed first, or start from a Sokosumi task if they already use Cardano. One DNS record proves ownership, API keys are sealed so only our gateway can use them, and Hirakumi registers the API as an agent on Masumi. Agents pay once with x402 on Cardano for a pack of 100 answers in USDM. Our gateway checks each answer against a public promise: a good answer uses one credit, a bad one is free, and a broken API stops selling. For large packs, the money waits in our Aiken smart contract, which pays the seller only for answers the agent signed as good, takes 3% for Hirakumi and refunds the rest. Nobody can take more than the agent agreed to, not even us. Live on Cardano preprod, with real packs paid and settled on chain.

## Real-world use cases

A bank, exchange, logistics firm or data provider can open an existing API to agents without a modernization project: prices and rates for trading agents, weather for travel agents, company data for research agents, translation or booking for assistant agents. Cardano settles the money for every pack while answers flow at web speed, about 0.3 seconds each, so even sub-cent answers are worth selling. Revenue is the 3% fee, paid by the contract only on good answers, plus a small listing fee per API. And it isn't only for enterprises: any developer or hobbyist with an API can make it ready to earn from agents within minutes.

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
