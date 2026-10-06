import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { internalRouter } from "../src/internal";
import type { AppDeps } from "../src/deps";

const TOKEN = "a-very-long-internal-token-123";

function app() {
  const invalidate = vi.fn();
  const deps = { config: { internalToken: TOKEN }, registry: { invalidate }, health: { reset: vi.fn() } } as unknown as AppDeps;
  const a = express();
  a.use(express.json());
  a.use(internalRouter(deps));
  return { a, invalidate };
}

describe("adversarial: /internal/* needs the exact bearer token", () => {
  it.each([
    ["no header", undefined],
    ["wrong token", "Bearer nope"],
    ["lower-case scheme", `bearer ${TOKEN}`],
    ["token without scheme", TOKEN],
    ["token prefix", `Bearer ${TOKEN.slice(0, -1)}`],
    ["token plus suffix", `Bearer ${TOKEN}x`],
  ])("%s is refused", async (_n, header) => {
    const { a, invalidate } = app();
    const r = request(a).post("/internal/apis/api_x/reload");
    const res = header ? await r.set("authorization", header) : await r;
    expect(res.status).toBe(401);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each(["/INTERNAL/apis/api_x/reload", "/Internal/apis/api_x/reload", "/internal/apis/api_x/reload/", "//internal/apis/api_x/reload", "/%69nternal/apis/api_x/reload"])(
    "path variant %s never reaches the handler without a token", async (path) => {
      const { a, invalidate } = app();
      await request(a).post(path);
      expect(invalidate).not.toHaveBeenCalled();
    });

  it("the right token works (control)", async () => {
    const { a, invalidate } = app();
    expect((await request(a).post("/internal/apis/api_x/reload").set("authorization", `Bearer ${TOKEN}`)).status).toBe(200);
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
