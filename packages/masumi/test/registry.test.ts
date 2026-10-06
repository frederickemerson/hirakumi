import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentIdentifier, getRegistryStatus, refreshRegistryStatus, registerAgent } from "../src/registry.js";
import { MASUMI_ESCROW_UNIT } from "../src/constants.js";
import { MasumiApiError, MasumiInputError } from "../src/errors.js";
import type { MasumiConfig } from "../src/types.js";
import { installFakeFetch, ok, type Recorded } from "./fakeFetch.js";

const C: MasumiConfig = {
  baseUrl: "http://ps.test/api/v1",
  token: "admin-key",
  network: "Preprod",
  registryUrl: "http://reg.test/api/v1",
  registryToken: "reg-key",
};
const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const VKEY = "a".repeat(56);
const AGENT_ID = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b" + "1".repeat(64);
const AGENT = {
  name: "Price API",
  description: "ADA price with a published promise",
  apiBaseUrl: "https://api.hirakumi.app/a/api_abc",
  priceMicros: 2_000_000n,
  unit: MASUMI_ESCROW_UNIT,
  tags: ["hirakumi", "prices"],
  exampleOutput: "https://api.hirakumi.app/r/sha256:abc",
};

const sourceRoutes = {
  "GET /api/v1/payment-source": () =>
    ok({
      PaymentSources: [
        { id: "ps_v1", network: "Preprod", paymentSourceType: "Web3CardanoV1", smartContractAddress: "addr_test1wv1" },
        { id: "ps_v2", network: "Preprod", paymentSourceType: "Web3CardanoV2", smartContractAddress: ESCROW },
      ],
    }),
  "GET /api/v1/wallet/list": (req: Recorded) => {
    expect(req.url.searchParams.get("walletType")).toBe("Selling");
    expect(req.url.searchParams.get("paymentSourceId")).toBe("ps_v2");
    return ok({ Wallets: [{ id: "w1", walletVkey: VKEY, walletAddress: "addr_test1qsell" }] });
  },
};

const entry = (over: Record<string, unknown> = {}) => ({
  id: "reg_1",
  state: "RegistrationRequested",
  agentIdentifier: null,
  error: null,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("registerAgent", () => {
  it("registers a V2 agent priced in Masumi tUSDM through the node's selling wallet", async () => {
    const { calls } = installFakeFetch({
      ...sourceRoutes,
      "POST /api/v1/registry": () => ok(entry()),
    });
    await expect(registerAgent(C, AGENT)).resolves.toEqual({ registrationId: "reg_1" });
    const body = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      network: "Preprod",
      sellingWalletVkey: VKEY,
      name: "Price API",
      description: AGENT.description,
      apiBaseUrl: AGENT.apiBaseUrl,
      Tags: ["hirakumi", "prices"],
      ExampleOutputs: [{ name: "example", url: AGENT.exampleOutput, mimeType: "application/json" }],
      Capability: { name: "hirakumi-openapi-wrapper", version: "1" },
      Author: { name: "Hirakumi" },
      supportedPaymentSources: [
        {
          chain: "Cardano",
          network: "Preprod",
          paymentSourceType: "Web3CardanoV2",
          address: ESCROW,
          pricing: { pricingType: "Fixed", fixed: [{ asset: MASUMI_ESCROW_UNIT, amount: "2000000" }] },
        },
      ],
    });
    expect(body).not.toHaveProperty("AgentPricing");
  });

  it("sends an empty ExampleOutputs list when there is no example", async () => {
    const { calls } = installFakeFetch({ ...sourceRoutes, "POST /api/v1/registry": () => ok(entry()) });
    await registerAgent(C, { ...AGENT, exampleOutput: undefined });
    expect((calls.find((c) => c.method === "POST")!.body as { ExampleOutputs: unknown[] }).ExampleOutputs).toEqual([]);
  });

  it("rejects bad listings before any network call", async () => {
    const { calls } = installFakeFetch({});
    const bad = [
      { ...AGENT, apiBaseUrl: "http://api.hirakumi.app/a/api_abc" },
      { ...AGENT, apiBaseUrl: "https://api.hirakumi.app/a/api_abc/" },
      { ...AGENT, tags: [] },
      { ...AGENT, tags: Array.from({ length: 16 }, (_, i) => `t${i}`) },
      { ...AGENT, tags: ["x".repeat(64)] },
      { ...AGENT, priceMicros: 0n },
      { ...AGENT, unit: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d" },
      { ...AGENT, name: "n".repeat(251) },
      { ...AGENT, exampleOutput: "ftp://example.test/x.json" },
    ];
    for (const listing of bad) {
      await expect(registerAgent(C, listing)).rejects.toBeInstanceOf(MasumiInputError);
    }
    expect(calls).toHaveLength(0);
  });

  it("fails clearly when the node has no Preprod V2 payment source", async () => {
    installFakeFetch({ "GET /api/v1/payment-source": () => ok({ PaymentSources: [] }) });
    await expect(registerAgent(C, AGENT)).rejects.toThrow(/no Preprod Web3CardanoV2 payment source/);
  });
});

describe("getAgentIdentifier", () => {
  it("returns null until the mint is confirmed", async () => {
    installFakeFetch({
      "GET /api/v1/registry": () => ok({ Assets: [entry({ state: "RegistrationInitiated", agentIdentifier: AGENT_ID })] }),
    });
    await expect(getAgentIdentifier(C, "reg_1")).resolves.toBeNull();
  });

  it("returns the agent identifier once RegistrationConfirmed", async () => {
    const { calls } = installFakeFetch({
      "GET /api/v1/registry": () => ok({ Assets: [entry({ state: "RegistrationConfirmed", agentIdentifier: AGENT_ID })] }),
    });
    await expect(getAgentIdentifier(C, "reg_1")).resolves.toBe(AGENT_ID);
    expect(calls[0].url.searchParams.get("network")).toBe("Preprod");
    expect(calls[0].url.searchParams.get("filterPaymentSourceType")).toBe("Web3CardanoV2");
    expect(calls[0].url.searchParams.get("limit")).toBe("100");
  });

  it("throws with the node's error when the registration failed", async () => {
    installFakeFetch({
      "GET /api/v1/registry": () => ok({ Assets: [entry({ state: "RegistrationFailed", error: "Not enough funds" })] }),
    });
    await expect(getAgentIdentifier(C, "reg_1")).rejects.toThrow(/Not enough funds/);
  });

  it("pages through the node's registry list with cursorId", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => entry({ id: `other_${i}` }));
    const { calls } = installFakeFetch({
      "GET /api/v1/registry": (req) =>
        req.url.searchParams.get("cursorId") === "other_99"
          ? ok({ Assets: [entry({ state: "RegistrationConfirmed", agentIdentifier: AGENT_ID })] })
          : ok({ Assets: page1 }),
    });
    await expect(getAgentIdentifier(C, "reg_1")).resolves.toBe(AGENT_ID);
    expect(calls).toHaveLength(2);
  });

  it("throws 404 when the registration does not exist on this node", async () => {
    installFakeFetch({ "GET /api/v1/registry": () => ok({ Assets: [] }) });
    const error = await getAgentIdentifier(C, "reg_missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MasumiApiError);
    expect((error as MasumiApiError).status).toBe(404);
  });
});

describe("registry status", () => {
  it("reads the entry by asset identifier from the registry service with the registry token", async () => {
    const { calls } = installFakeFetch({
      "POST /api/v1/registry-entry/": () => ok({ entries: [{ status: "Offline", lastUptimeCheck: "2026-10-07T03:00:00.000Z" }] }),
    });
    await expect(getRegistryStatus(C, AGENT_ID)).resolves.toBe("Offline");
    expect(calls[0].url.host).toBe("reg.test");
    expect(calls[0].headers.token).toBe("reg-key");
    expect(calls[0].body).toEqual({ network: "Preprod", filter: { assetIdentifier: AGENT_ID }, limit: 1 });
  });

  it("returns Unknown when the registry has not indexed the agent yet", async () => {
    installFakeFetch({ "POST /api/v1/registry-entry/": () => ok({ entries: [] }) });
    await expect(getRegistryStatus(C, AGENT_ID)).resolves.toBe("Unknown");
  });

  it("forces a fresh health check with refreshRegistryStatus", async () => {
    const { calls } = installFakeFetch({
      "POST /api/v1/registry-entry-refresh/": () => ok({ entry: { status: "Online" } }),
    });
    await expect(refreshRegistryStatus(C, AGENT_ID)).resolves.toBe("Online");
    expect(calls[0].body).toEqual({ network: "Preprod", agentIdentifier: AGENT_ID });
  });

  it("refuses to run without a registry token", async () => {
    const { calls } = installFakeFetch({});
    await expect(getRegistryStatus({ ...C, registryToken: undefined }, AGENT_ID)).rejects.toBeInstanceOf(MasumiInputError);
    expect(calls).toHaveLength(0);
  });
});
