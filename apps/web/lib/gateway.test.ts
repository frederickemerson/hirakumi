import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { startMockGateway } from "@/scripts/mock-gateway";
import { jsonResponse } from "@/test/http";
import { createGateway, GatewayError } from "./gateway";

function gatewayWith(fetchImpl: typeof fetch) {
  return createGateway({ baseUrl: "https://gw.test/", token: "tok", fetchImpl });
}

describe("gateway client", () => {
  it("calls the challenge check with the bearer token and returns the result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, reason: "missing", record: "_hirakumi.x.dev", detail: "No TXT record found at _hirakumi.x.dev yet." }));
    const result = await gatewayWith(fetchImpl).checkChallenge("api_1");
    expect(result).toEqual({ ok: false, reason: "missing", record: "_hirakumi.x.dev", detail: "No TXT record found at _hirakumi.x.dev yet." });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.test/internal/challenge/api_1/check");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("turns a network failure or timeout into a plain-English message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await gatewayWith(fetchImpl).checkChallenge("api_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).userMessage).toBe("We couldn't reach the Hirakumi checker. Try again in a minute.");
  });

  it("explains an auth failure without leaking the token", async () => {
    const err = await gatewayWith(vi.fn(async () => new Response("", { status: 401 }))).reloadApi("api_1").catch((e: unknown) => e);
    expect((err as GatewayError).userMessage).toBe("Hirakumi's checker isn't set up correctly right now. Try again later.");
    expect((err as GatewayError).message).not.toContain("tok");
  });

  it("rejects an answer with the wrong shape", async () => {
    const err = await gatewayWith(vi.fn(async () => jsonResponse({ ok: "yes" }))).checkChallenge("api_1").catch((e: unknown) => e);
    expect((err as GatewayError).userMessage).toBe("The Hirakumi checker sent an unreadable answer. Try again in a minute.");
  });

  it("reads health", async () => {
    const health = await gatewayWith(vi.fn(async () => jsonResponse({ health: "down", checkedAt: "2026-10-06T12:00:00Z", lastReasons: ["$.price missing", 3] })))
      .getHealth("api_1");
    expect(health).toEqual({ health: "down", checkedAt: "2026-10-06T12:00:00Z", lastReasons: ["$.price missing"] });
  });

  it("reads settlement per pack, drops malformed entries, and waits at most 3 s", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ packMode: "hybrid", packs: [
      { packId: "pk_1", mode: "escrow", reasons: ["new seller", 4] },
      { packId: "pk_2", mode: "direct", reasons: ["large pack"], recommended: "escrow" },
      { packId: "pk_3", mode: "both", reasons: [] },
    ] }));
    expect(await gatewayWith(fetchImpl).getSettlement("api_1")).toEqual([
      { packId: "pk_1", mode: "escrow", reasons: ["new seller"] },
      { packId: "pk_2", mode: "direct", reasons: ["large pack"], recommended: "escrow" },
    ]);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://gw.test/internal/apis/api_1/settlement");
  });

  it("works against the mock gateway over real HTTP", async () => {
    const server = await startMockGateway(0, "tok", { challengeOk: true });
    try {
      const { port } = server.address() as AddressInfo;
      const gw = createGateway({ baseUrl: `http://127.0.0.1:${port}`, token: "tok" });
      expect((await gw.checkChallenge("api_9")).ok).toBe(true);
      await expect(gw.reloadApi("api_9")).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
