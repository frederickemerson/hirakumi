import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE = {
  DATABASE_URL: "postgres://hirakumi:hirakumi@localhost:5432/hirakumi",
  PUBLIC_BASE_URL: "https://api.hirakumi.app/",
  INTERNAL_TOKEN: "internal",
  WEB_BASE_URL: "https://hirakumi.vercel.app/",
  ANTHROPIC_API_KEY: "sk-ant-test",
  PAYMENT_SERVICE_URL: "http://payment-service:3001/api/v1",
  PAYMENT_SERVICE_TOKEN: "pay",
  MASUMI_ESCROW_UNIT: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d",
};

describe("loadConfig", () => {
  it("falls back to dashboard mode when the Sokosumi key is empty", () => {
    const c = loadConfig({ ...BASE, SOKOSUMI_COWORKER_API_KEY: "" });
    expect(c.sokosumi).toBeNull();
    expect(c.publicBaseUrl).toBe("https://api.hirakumi.app");
    expect(c.webBaseUrl).toBe("https://hirakumi.vercel.app");
    expect(c.gatewayInternalUrl).toBe("http://gateway:4021");
    expect(c.onboardingCredits).toBe(1500);
  });

  it("enables Sokosumi and strips a trailing /v1 from the API URL", () => {
    const c = loadConfig({ ...BASE, SOKOSUMI_COWORKER_API_KEY: "coworker_abc", SOKOSUMI_API_URL: "https://api.preprod.sokosumi.com/v1/" });
    expect(c.sokosumi).toEqual({ apiUrl: "https://api.preprod.sokosumi.com", apiKey: "coworker_abc" });
  });

  it("throws on a missing required variable", () => {
    const { ANTHROPIC_API_KEY: _drop, ...rest } = BASE;
    expect(() => loadConfig(rest)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("rejects a non-positive onboarding fee", () => {
    expect(() => loadConfig({ ...BASE, COWORKER_ONBOARDING_CREDITS: "0" })).toThrow(/COWORKER_ONBOARDING_CREDITS/);
  });
});
