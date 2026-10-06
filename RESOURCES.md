# Cardano Agentic Commerce: Resources

TOKEN2049 Origins Hackathon, Cardano track. Submit by **7 Oct 2026, 11:59pm** (Singapore).

> **Track rules that affect the code** (from the official agent brief, `docs/reference/x402-cardano-agent.md`)
> - **Preprod only** (`cardano:preprod`). No mainnet.
> - Pin **all `@x402/*` packages to exactly `2.26.0`**. npm `latest` is 2.28.0, so do not use it.
> - Cardano x402 is **TypeScript-only**. The Python and Go x402 SDKs don't support Cardano yet.
> - The public x402.org facilitator **does not** support Cardano. Use a local facilitator or the hosted one for the event.

## 1. Official track resources (from the challenge page)

| Resource | Link |
|---|---|
| Developer Portal x402 hub (live and updated during the event) | https://developers.cardano.org/x402 |
| x402 agent brief, to feed to your coding agent | https://developers.cardano.org/x402/agent.md → local copy: `docs/reference/x402-cardano-agent.md` |
| Code with AI: Cardano agent skills | https://developers.cardano.org/docs/developers/curriculum/start-building/ai-assisted-development |
| Extending x402 (Masumi) | https://www.masumi.network · https://www.masumi.network/x402 |
| Code with AI: Masumi skills | https://www.masumi.network/dev/masumi/documentation/integrations/masumi-skills |

## 2. Skill files (installed and linked in this repo)

Both skill repos are cloned into `vendor/` and symlinked into `.claude/skills/`, so Claude Code loads them automatically in this project.

### Cardano Dev Skills: [cardano-foundation/cardano-dev-skills](https://github.com/cardano-foundation/cardano-dev-skills) ([site](https://cardano-foundation.github.io/cardano-dev-skills/))

| Skill | File |
|---|---|
| cardano-context (run this first to wire the project) | [.claude/skills/cardano-context/SKILL.md](.claude/skills/cardano-context/SKILL.md) |
| scaffold-project | [.claude/skills/scaffold-project/SKILL.md](.claude/skills/scaffold-project/SKILL.md) |
| build-transaction | [.claude/skills/build-transaction/SKILL.md](.claude/skills/build-transaction/SKILL.md) |
| connect-wallet | [.claude/skills/connect-wallet/SKILL.md](.claude/skills/connect-wallet/SKILL.md) |
| query-chain | [.claude/skills/query-chain/SKILL.md](.claude/skills/query-chain/SKILL.md) |
| debug-transaction | [.claude/skills/debug-transaction/SKILL.md](.claude/skills/debug-transaction/SKILL.md) |
| write-validator (Aiken) | [.claude/skills/write-validator/SKILL.md](.claude/skills/write-validator/SKILL.md) |
| review-contract | [.claude/skills/review-contract/SKILL.md](.claude/skills/review-contract/SKILL.md) |
| optimize-validator | [.claude/skills/optimize-validator/SKILL.md](.claude/skills/optimize-validator/SKILL.md) |
| design-token | [.claude/skills/design-token/SKILL.md](.claude/skills/design-token/SKILL.md) |
| setup-devnet | [.claude/skills/setup-devnet/SKILL.md](.claude/skills/setup-devnet/SKILL.md) |
| suggest-tooling | [.claude/skills/suggest-tooling/SKILL.md](.claude/skills/suggest-tooling/SKILL.md) |
| suggest-scalability | [.claude/skills/suggest-scalability/SKILL.md](.claude/skills/suggest-scalability/SKILL.md) |
| explain-eutxo | [.claude/skills/explain-eutxo/SKILL.md](.claude/skills/explain-eutxo/SKILL.md) |
| explain-cip | [.claude/skills/explain-cip/SKILL.md](.claude/skills/explain-cip/SKILL.md) |
| explain-zk | [.claude/skills/explain-zk/SKILL.md](.claude/skills/explain-zk/SKILL.md) |
| governance-guide | [.claude/skills/governance-guide/SKILL.md](.claude/skills/governance-guide/SKILL.md) |
| give-feedback | [.claude/skills/give-feedback/SKILL.md](.claude/skills/give-feedback/SKILL.md) |

Official plugin install (an alternative to the local symlinks):
```
/plugin marketplace add cardano-foundation/cardano-dev-skills
/plugin install cardano-dev-skills@cardano-dev-skills
```

### Masumi Skill: [masumi-network/masumi-skills](https://github.com/masumi-network/masumi-skills)

| File | Topic |
|---|---|
| [.claude/skills/masumi/SKILL.md](.claude/skills/masumi/SKILL.md) | Entry point |
| [references/masumi-payments.md](vendor/masumi-skills/skill/references/masumi-payments.md) | Payment service, escrow lifecycle |
| [references/masumi-registry-api.md](vendor/masumi-skills/skill/references/masumi-registry-api.md) | Registry API |
| [references/registry-identity.md](vendor/masumi-skills/skill/references/registry-identity.md) | Agent identity and registry |
| [references/agentic-services.md](vendor/masumi-skills/skill/references/agentic-services.md) | MIP-003 Agentic Service API |
| [references/smart-contracts.md](vendor/masumi-skills/skill/references/smart-contracts.md) | Escrow contracts, refunds, disputes |
| [references/cardano-blockchain.md](vendor/masumi-skills/skill/references/cardano-blockchain.md) | Cardano basics for Masumi |
| [references/sokosumi-marketplace.md](vendor/masumi-skills/skill/references/sokosumi-marketplace.md) | Sokosumi marketplace |
| [references/sokosumi-api-reference.md](vendor/masumi-skills/skill/references/sokosumi-api-reference.md) | Sokosumi API |
| [references/kodosumi-runtime.md](vendor/masumi-skills/skill/references/kodosumi-runtime.md) | Kodosumi runtime (scaling) |
| [references/api-debug-recipes.md](vendor/masumi-skills/skill/references/api-debug-recipes.md) | Debug recipes |

Other ways to install it: `npx skills add https://github.com/masumi-network/masumi-skills --skill masumi`. There is also a single-file version at https://www.masumi.network/skill.md (local copy: `docs/reference/masumi-skill.md`).

## 3. SDKs and packages

### x402 (TypeScript, pinned to `2.26.0`)
```bash
npm i -E @x402/cardano@2.26.0 @x402/core@2.26.0 @x402/express@2.26.0 @x402/fetch@2.26.0
# Next.js:  npm i -E @x402/next@2.26.0   (needs next >= 16.2.6)
# Others:   @x402/hono  @x402/axios
```
| Package | Purpose |
|---|---|
| [`@x402/cardano`](https://www.npmjs.com/package/@x402/cardano) | `toClientCardanoSigner`, `toFacilitatorCardanoSigner`, `ExactCardanoScheme` (`/exact/client\|server\|facilitator`), `USDM_PREPROD_ASSET` |
| [`@x402/core`](https://www.npmjs.com/package/@x402/core) | types, `HTTPFacilitatorClient`, `x402Facilitator` |
| [`@x402/express`](https://www.npmjs.com/package/@x402/express) | `paymentMiddleware`, `x402ResourceServer` (seller) |
| [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) | `x402Client`, `wrapFetchWithPayment` (buyer agent) |
| [`@x402/next`](https://www.npmjs.com/package/@x402/next) | `withX402` route wrapper |
| [`@x402/hono`](https://www.npmjs.com/package/@x402/hono), [`@x402/axios`](https://www.npmjs.com/package/@x402/axios) | Other server and client adapters |

### Masumi
| Package / repo | Purpose |
|---|---|
| [masumi-payment-service](https://github.com/masumi-network/masumi-payment-service) | Self-hosted node for payments, escrow, refunds, disputes and the registry API |
| [masumi-registry-service](https://github.com/masumi-network/masumi-registry-service) | Agent registry and discovery service |
| [`masumi` (PyPI)](https://pypi.org/project/masumi/) · [repo](https://github.com/masumi-network/pip-masumi) · [examples](https://github.com/masumi-network/pip-masumi-examples) | Python payment module for agents |
| [`@masumi_network/identity-sdk`](https://www.npmjs.com/package/@masumi_network/identity-sdk) · [repo](https://github.com/masumi-network/masumi-identity-sdk) | Agent identity (KERI AIDs, Verifiable Credentials, DIDs) |
| [`@masumi_network/masumi-agent-messenger`](https://www.npmjs.com/package/@masumi_network/masumi-agent-messenger) | Encrypted agent-to-agent messaging CLI |
| [masumi-mcp-server](https://github.com/masumi-network/masumi-mcp-server) · [Sokosumi-MCP](https://github.com/masumi-network/Sokosumi-MCP) | MCP servers |
| [n8n-nodes-masumi-payment](https://github.com/masumi-network/n8n-nodes-masumi-payment) | n8n payment nodes |
| [crewai-masumi-quickstart-template](https://github.com/masumi-network/crewai-masumi-quickstart-template) · [langgraph-masumi-quickstart-template](https://github.com/masumi-network/langgraph-masumi-quickstart-template) | Agent framework starters |
| [masumi-improvement-proposals](https://github.com/masumi-network/masumi-improvement-proposals) | MIPs, including MIP-003 |
| [masumi-docs](https://github.com/masumi-network/masumi-docs) | Docs source |

### General Cardano SDKs
| Package | Purpose |
|---|---|
| [`@meshsdk/core`](https://meshjs.dev) ([AI docs](https://meshjs.dev/ai)) | Transactions and wallets (CIP-30) |
| [`@lucid-evolution/lucid`](https://github.com/Anastasia-Labs/lucid-evolution) | Transaction builder |
| [`@blockfrost/blockfrost-js`](https://blockfrost.io) | Chain API. Free preprod key at blockfrost.io |
| [Aiken](https://aiken-lang.org) | Smart contract language |

## 4. Templates and examples

```bash
# Express seller + buyer agent + local facilitator
npx giget@latest gh:cardano-foundation/developer-portal/examples/templates/x402-express my-app
# Next.js paywall with CIP-30 browser wallet (Eternl, Lace)
npx giget@latest gh:cardano-foundation/developer-portal/examples/templates/x402-next my-app
```
- Full protocol demo (browser wallet, USDM, Masumi escrow routes): https://github.com/cardano-foundation/x402-cardano-demo
- Next template source: https://github.com/cardano-foundation/developer-portal/tree/staging/examples/templates/x402-next
- Masumi x402 fork: https://github.com/masumi-network/x402 · older examples: https://github.com/masumi-network/x402-cardano-examples

## 5. Specs and docs

- x402 docs: https://docs.x402.org ([network support](https://docs.x402.org/core-concepts/network-and-token-support) · [exact scheme](https://docs.x402.org/schemes/exact))
- Cardano `exact` scheme spec: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md (local copy: `docs/reference/scheme_exact_cardano.md`)
- Masumi docs: https://www.masumi.network/dev/masumi/documentation · API: https://www.masumi.network/docs/api
- Masumi agent explorer (registry): https://www.masumi.network/agent-explorer · register: https://www.masumi.network/register
- Sokosumi marketplace: https://sokosumi.com · Kodosumi runtime: https://kodosumi.io

## 6. Infrastructure

| Item | Link |
|---|---|
| Hosted facilitator (preprod) | `https://x402.preprod.dev.ecosyseng.cf-deployments.org` ([/supported](https://x402.preprod.dev.ecosyseng.cf-deployments.org/supported)) |
| Local facilitator (fallback) | `npm run facilitator` in the template, port 4022 |
| Test ADA faucet (choose Preprod) | https://docs.cardano.org/cardano-testnets/tools/faucet |
| tUSDM (cent pricing) | https://tusdm.moneta.global |
| Explorer | https://preprod.cardanoscan.io |
| Blockfrost key | https://blockfrost.io |

## 7. Community and help
- Cardano dev Discord: https://discord.gg/MmeqpAzKbp · Masumi Discord: https://discord.com/invite/aj4QfnTS92
- Cardano Stack Exchange: https://cardano.stackexchange.com · Forum: https://forum.cardano.org/c/developers/29
