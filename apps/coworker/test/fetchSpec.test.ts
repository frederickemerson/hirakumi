import { UpstreamBlockedError, UpstreamRedirectError, type UpstreamResult } from "@hirakumi/core";
import { describe, expect, it, vi } from "vitest";
import { PermanentError } from "../src/errors.js";
import { createSpecFetcher, SPEC_MAX_BYTES, SpecNotServedError } from "../src/openapi/fetchSpec.js";

const ok = (body: string, status = 200): UpstreamResult => ({ status, contentType: "application/json", body, latencyMs: 3 });

describe("createSpecFetcher", () => {
  it("fetches through safeFetch with a 1 MB cap", async () => {
    const safe = vi.fn().mockResolvedValue(ok("{}"));
    await expect(createSpecFetcher(safe)("https://p.dev/openapi.json")).resolves.toBe("{}");
    expect(safe).toHaveBeenCalledWith("https://p.dev/openapi.json", expect.objectContaining({ method: "GET" }), { timeoutMs: 15_000, maxBytes: SPEC_MAX_BYTES });
  });

  it("turns a blocked URL into a permanent, plain-English error", async () => {
    const safe = vi.fn().mockRejectedValue(new UpstreamBlockedError("private address"));
    await expect(createSpecFetcher(safe)("https://10.0.0.1/o.json")).rejects.toBeInstanceOf(PermanentError);
  });

  it("treats a non-200 as permanent", async () => {
    const safe = vi.fn().mockResolvedValue(ok("nope", 404));
    await expect(createSpecFetcher(safe)("https://p.dev/missing.json")).rejects.toThrow(/HTTP 404/);
    await expect(createSpecFetcher(safe)("https://p.dev/missing.json")).rejects.toMatchObject({ status: 404 });
  });

  it("marks an answer that isn't a file (non-200 or a redirect) apart from a fetch failure", async () => {
    const redirect = vi.fn().mockRejectedValue(new UpstreamRedirectError(302, "/docs"));
    const p = createSpecFetcher(redirect)("https://p.dev/");
    await expect(p).rejects.toBeInstanceOf(SpecNotServedError);
    await expect(p).rejects.toThrow(/no redirects/);
    const blocked = createSpecFetcher(vi.fn().mockRejectedValue(new UpstreamBlockedError("private address")))("https://10.0.0.1/o.json");
    await expect(blocked).rejects.not.toBeInstanceOf(SpecNotServedError);
  });

  it("lets network errors through so the step retries", async () => {
    const safe = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const p = createSpecFetcher(safe)("https://p.dev/o.json");
    await expect(p).rejects.toThrow("ECONNRESET");
    await expect(p).rejects.not.toBeInstanceOf(PermanentError);
  });
});
