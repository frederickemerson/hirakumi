import { describe, expect, it, vi } from "vitest";
import type { UpstreamCredential } from "@hirakumi/core";

// safeFetch is replaced so each error branch can quote the full request URL, as a network library might.
const fetchError = vi.hoisted(() => ({ make: (_url: string): Error => new Error("unset") }));
vi.mock("@hirakumi/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@hirakumi/core")>();
  return { ...core, safeFetch: vi.fn(async (url: string) => { throw fetchError.make(url); }) };
});

const core = await import("@hirakumi/core");
const { compileRule } = core;
const { compileInputValidator } = await import("../src/registry");
const { runOperation } = await import("../src/upstream");
const { PRICE_INPUT_SCHEMA, PRICE_RULE } = await import("./helpers");

const KEY = "qk_9f8e7d6c5b4a/3210";
const credential: UpstreamCredential = { in: "query", name: "api_key", value: KEY };
const op = {
  row: { id: "op_x", api_id: "api_x", op_id: "getPrice", method: "GET", path: "/price", input_schema: PRICE_INPUT_SCHEMA, description: null, enabled: true },
  ruleRow: null, rule: compileRule(PRICE_RULE), validateInput: compileInputValidator(PRICE_INPUT_SCHEMA),
};

describe("runOperation never passes on a reason that quotes the key", () => {
  it.each([
    ["timeout", (u: string) => new core.UpstreamTimeoutError(`upstream ${u} did not answer`), "timeout"],
    ["blocked", (u: string) => new core.UpstreamBlockedError(`not a valid URL: ${u}`), "blocked"],
    ["too large", (u: string) => new core.UpstreamTooLargeError(`${u} is over 1 MB`), "upstream_error"],
    ["other", (u: string) => new Error(`request to ${u} failed, reason: ECONNRESET`), "upstream_error"],
  ] as const)("%s", async (_label, make, execution) => {
    fetchError.make = make;
    const o = await runOperation({ origin: "https://a.example", path_prefix: "/", credential, credentialError: null }, op, { symbol: "ADA" }, { timeoutMs: 100 });
    expect(o.execution).toBe(execution);
    expect(o.reasons[0]).toContain("https://a.example/price?symbol=ADA&api_key=[key]");
    expect(JSON.stringify(o)).not.toContain(KEY);
    expect(JSON.stringify(o)).not.toContain(encodeURIComponent(KEY));
  });
  it("redacts every secret part of a bag (hks3) from the reason, and not its fixed text", async () => {
    fetchError.make = (u) => new Error(`request to ${u} failed`);
    const auth = core.validateUpstreamBag(
      [{ in: "query", name: "v" }, { in: "query", name: "api_key" }], { values: ["2024-01", KEY], fixed: [0], leak: [] },
    );
    const o = await runOperation({ origin: "https://a.example", path_prefix: "/", auth }, op, { symbol: "ADA" }, { timeoutMs: 100 });
    expect(o.reasons[0]).toContain("https://a.example/price?symbol=ADA&v=2024-01&api_key=[key]");
    expect(JSON.stringify(o)).not.toContain(encodeURIComponent(KEY));
  });
});
