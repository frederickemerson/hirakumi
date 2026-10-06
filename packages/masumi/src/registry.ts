import { call } from "./http.js";
import { MasumiApiError, MasumiInputError } from "./errors.js";
import { DEFAULT_REGISTRY_URL, MASUMI_ESCROW_UNIT, PAYMENT_SOURCE_TYPE } from "./constants.js";
import type { MasumiConfig, RegistryStatus } from "./types.js";

export type AgentListing = {
  name: string;
  description: string;
  apiBaseUrl: string;
  priceMicros: bigint;
  unit: string;
  tags: string[];
  exampleOutput?: string;
};

type PaymentSourceDto = { id: string; network: string; paymentSourceType: string; smartContractAddress: string };
type WalletDto = { id: string; walletVkey: string; walletAddress: string };
type RegistrationDto = { id: string; state: string; agentIdentifier: string | null; error: string | null };

const PAGE = 100;
const MAX_PAGES = 50;
const MINTED = new Set(["RegistrationConfirmed", "UpdateRequested", "UpdateInitiated", "UpdateConfirmed", "UpdateFailed"]);
const STATUSES = new Set<RegistryStatus>(["Online", "Offline", "Deregistered", "Invalid"]);

function httpsUrl(field: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MasumiInputError(`${field} is not a URL: ${value}`);
  }
  if (url.protocol !== "https:") throw new MasumiInputError(`${field} must use https: ${value}`);
  if (value.length > 250) throw new MasumiInputError(`${field} must be at most 250 characters`);
  return url;
}

function validateListing(a: AgentListing): void {
  httpsUrl("apiBaseUrl", a.apiBaseUrl);
  if (a.apiBaseUrl.endsWith("/")) {
    throw new MasumiInputError(`apiBaseUrl must not end with "/": the registry appends "/availability" (${a.apiBaseUrl})`);
  }
  if (a.exampleOutput !== undefined) httpsUrl("exampleOutput", a.exampleOutput);
  if (a.name.length < 1 || a.name.length > 250) throw new MasumiInputError("name must be 1-250 characters");
  if (a.description.length < 1 || a.description.length > 250) throw new MasumiInputError("description must be 1-250 characters");
  if (a.tags.length < 1 || a.tags.length > 15) throw new MasumiInputError("tags must have 1-15 entries");
  for (const tag of a.tags) {
    if (tag.length < 1 || tag.length > 63) throw new MasumiInputError(`tag "${tag}" must be 1-63 characters`);
  }
  if (a.priceMicros <= 0n) throw new MasumiInputError("priceMicros must be positive");
  if (a.unit !== MASUMI_ESCROW_UNIT) {
    throw new MasumiInputError(`escrow must be priced in Masumi tUSDM (${MASUMI_ESCROW_UNIT}), not ${a.unit}`);
  }
}

async function v2Source(c: MasumiConfig): Promise<PaymentSourceDto> {
  const { PaymentSources } = await call<{ PaymentSources: PaymentSourceDto[] }>(c.baseUrl, c.token, "GET", "/payment-source", {
    query: { take: 100 },
  });
  const source = PaymentSources.find((s) => s.network === c.network && s.paymentSourceType === PAYMENT_SOURCE_TYPE);
  if (!source) {
    throw new MasumiApiError(404, "/payment-source", `no ${c.network} ${PAYMENT_SOURCE_TYPE} payment source is seeded on this node`);
  }
  return source;
}

async function sellingWallet(c: MasumiConfig, paymentSourceId: string): Promise<WalletDto> {
  const { Wallets } = await call<{ Wallets: WalletDto[] }>(c.baseUrl, c.token, "GET", "/wallet/list", {
    query: { walletType: "Selling", paymentSourceId, take: 1 },
  });
  if (!Wallets[0]) throw new MasumiApiError(404, "/wallet/list", "no selling wallet on the V2 payment source");
  return Wallets[0];
}

/** Mints the agent's registry NFT (V2 metadata) from the node's selling wallet, which pays the mint. */
export async function registerAgent(c: MasumiConfig, a: AgentListing): Promise<{ registrationId: string }> {
  validateListing(a);
  const source = await v2Source(c);
  const wallet = await sellingWallet(c, source.id);
  const registration = await call<RegistrationDto>(c.baseUrl, c.token, "POST", "/registry", {
    body: {
      network: c.network,
      sellingWalletVkey: wallet.walletVkey,
      name: a.name,
      description: a.description,
      apiBaseUrl: a.apiBaseUrl,
      Tags: a.tags,
      ExampleOutputs: a.exampleOutput ? [{ name: "example", url: a.exampleOutput, mimeType: "application/json" }] : [],
      Capability: { name: "hirakumi-openapi-wrapper", version: "1" },
      Author: { name: "Hirakumi" },
      supportedPaymentSources: [
        {
          chain: "Cardano",
          network: c.network,
          paymentSourceType: PAYMENT_SOURCE_TYPE,
          address: source.smartContractAddress,
          pricing: { pricingType: "Fixed", fixed: [{ asset: a.unit, amount: a.priceMicros.toString() }] },
        },
      ],
    },
  });
  return { registrationId: registration.id };
}

/** The 120-hex agent identifier once the mint is confirmed; null while it is pending. */
export async function getAgentIdentifier(c: MasumiConfig, registrationId: string): Promise<string | null> {
  let cursorId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { Assets } = await call<{ Assets: RegistrationDto[] }>(c.baseUrl, c.token, "GET", "/registry", {
      query: { network: c.network, filterPaymentSourceType: PAYMENT_SOURCE_TYPE, limit: PAGE, cursorId },
    });
    const hit = Assets.find((asset) => asset.id === registrationId);
    if (hit) {
      if (hit.state === "RegistrationFailed") {
        throw new MasumiApiError(409, "/registry", `registration ${registrationId} failed: ${hit.error ?? "no error message"}`);
      }
      return MINTED.has(hit.state) && hit.agentIdentifier ? hit.agentIdentifier : null;
    }
    if (Assets.length < PAGE) break;
    const next = Assets[Assets.length - 1].id;
    if (next === cursorId) break;
    cursorId = next;
  }
  throw new MasumiApiError(404, "/registry", `registration ${registrationId} not found on this node`);
}

function registry(c: MasumiConfig): { url: string; token: string } {
  if (!c.registryToken) {
    throw new MasumiInputError("Registry status needs a registry token: set REGISTRY_API_KEY (and REGISTRY_SERVICE_URL)");
  }
  return { url: c.registryUrl ?? DEFAULT_REGISTRY_URL, token: c.registryToken };
}

const toStatus = (status: unknown): RegistryStatus =>
  typeof status === "string" && STATUSES.has(status as RegistryStatus) ? (status as RegistryStatus) : "Unknown";

/** The registry service's last known status (refreshed by its own schedule). */
export async function getRegistryStatus(c: MasumiConfig, agentIdentifier: string): Promise<RegistryStatus> {
  const r = registry(c);
  const { entries } = await call<{ entries: Array<{ status?: string }> }>(r.url, r.token, "POST", "/registry-entry/", {
    body: { network: c.network, filter: { assetIdentifier: agentIdentifier }, limit: 1 },
  });
  return toStatus(entries[0]?.status);
}

/** Makes the registry re-index and health-check this one agent now, then returns the fresh status. */
export async function refreshRegistryStatus(c: MasumiConfig, agentIdentifier: string): Promise<RegistryStatus> {
  const r = registry(c);
  const { entry } = await call<{ entry: { status?: string } | null }>(r.url, r.token, "POST", "/registry-entry-refresh/", {
    body: { network: c.network, agentIdentifier },
  });
  return toStatus(entry?.status);
}
