import { describe, expect, it } from "vitest";
import { masumiConfigFromEnv } from "../src/config.js";
import * as api from "../src/index.js";

describe("masumiConfigFromEnv", () => {
  it("reads the contract env names and defaults the registry URL", () => {
    expect(
      masumiConfigFromEnv({
        PAYMENT_SERVICE_URL: "http://payment-service:3001/api/v1",
        PAYMENT_SERVICE_TOKEN: "t",
        REGISTRY_API_KEY: "r",
      }),
    ).toEqual({
      baseUrl: "http://payment-service:3001/api/v1",
      token: "t",
      network: "Preprod",
      registryUrl: "https://registry.masumi.network/api/v1",
      registryToken: "r",
    });
  });

  it("names the missing variable", () => {
    expect(() => masumiConfigFromEnv({ PAYMENT_SERVICE_URL: "http://x/api/v1" })).toThrow(/PAYMENT_SERVICE_TOKEN/);
  });
});

describe("public API", () => {
  it("exports every contract function", () => {
    for (const name of [
      "registerAgent",
      "getAgentIdentifier",
      "getRegistryStatus",
      "createPaymentRequest",
      "getPaymentState",
      "submitResult",
      "createPurchase",
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
