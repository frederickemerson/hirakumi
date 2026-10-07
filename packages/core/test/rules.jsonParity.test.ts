import { describe, expect, it } from "vitest";
import { inferRule, inferRuleFromResponses, ruleHash, type UpstreamResult } from "../src/index";

/**
 * Hashes that main's inferRule gives for these samples (computed from origin/main packages/core/src/rules.ts). A live
 * JSON listing's rule hash is published on chain and in the registry, so JSON promises stay byte for byte as main
 * builds them: no added error-key check.
 */
const MAIN: [name: string, samples: unknown[], errorSample: unknown, hash: string][] = [
  ["price", [{ symbol: "ADA", priceUsd: 0.35, source: "coingecko" }, { symbol: "BTC", priceUsd: 62000, source: "coingecko" }], undefined,
    "sha256:ff5e809b23efc229f82560c19d45f582f9ff0a8c2c45e7fc9b76858ce53a0533"],
  ["price+error", [{ symbol: "ADA", priceUsd: 0.35 }, { symbol: "BTC", priceUsd: 62000 }], { error: "unknown symbol" },
    "sha256:cb6da29087da3ab17a13bc7d2718c15e284f3631c9b55bc997323a5d1149f349"],
  ["nested", [{ data: { id: "1", tags: ["a"] }, meta: { page: 1 } }, { data: { id: "2", tags: [] }, meta: { page: 2 } }], undefined,
    "sha256:a8fe444be53ab1bb488a40f324a0f920509b056a8c21aea0aeaa474b81c101c8"],
  ["mixed", [{ v: 1 }, { v: "1" }], undefined, "sha256:a988e83572e0148a930b8552cd8970a1a3901626f9343a5598feca229facc213"],
  ["array", [[{ a: 1 }], [{ a: 2, b: true }]], undefined, "sha256:e7893503fac4ce77437e556181633ce79c5e14eee926a4e7f8d94fc3cbf16353"],
  ["scalar", [1, 2.5], undefined, "sha256:1e69e593e2311a5444e32282b47fc4bc27d6446275debe5fac7be47922950d30"],
  ["errorKeyInSamples", [{ error: null, value: 1 }, { error: null, value: 2 }], { error: "bad", value: 0 },
    "sha256:97a96e3a9b3f6ac64a0667067f18819c5b7f0c88ba08a4164a0b137b04073066"],
  ["tightened", [{ a: 1, b: 2 }, { a: 3, b: 4 }], { a: 0, b: 0, error: "x", code: 4 },
    "sha256:5b54263d20bf2c834ba9e41e782dae0938e21a9ab55d1e5271268787e97c69f9"],
];

const res = (body: unknown, status = 200): UpstreamResult => ({ status, contentType: "application/json", body: JSON.stringify(body), latencyMs: 1 });

describe("JSON promises are built exactly as on main", () => {
  it.each(MAIN)("inferRule %s", (_name, samples, errorSample, hash) => {
    expect(ruleHash(inferRule(samples, errorSample))).toBe(hash);
  });

  it.each(MAIN)("inferRuleFromResponses %s", (_name, samples, errorSample, hash) => {
    const bad = errorSample === undefined ? null : res(errorSample);
    expect(ruleHash(inferRuleFromResponses(samples.map((s) => res(s)), bad))).toBe(hash);
  });

  it("adds no check for an error key the samples never had", () => {
    expect(inferRule([{ symbol: "ADA", priceUsd: 0.35 }]).schema.not).toBeUndefined();
  });
});
