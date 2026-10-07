import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { setExposureFetchForTests } from "@/lib/exposure";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedRule, seedSeller } from "@/test/factories";
import { ctx } from "@/test/requests";
import { POST } from "./apis/[apiId]/exposure/route";

const call = (apiId: string, token: string | null) =>
  POST(new Request(`https://web.hirakumi.test/api/internal/apis/${apiId}/exposure`, {
    method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {},
  }), ctx(apiId));

/** The coworker's leak check: the web app runs it, so the seller's API sees the web's address, not the gateway host's. */
describe("POST /api/internal/apis/:apiId/exposure", () => {
  const fetchFake = vi.fn(async () => ({ status: 401, contentType: "application/json", body: "{}", latencyMs: 1 }));
  beforeEach(async () => {
    await resetDb();
    fetchFake.mockClear();
    setExposureFetchForTests(fetchFake);
  });
  afterEach(() => setExposureFetchForTests(null));

  it("needs the internal token", async () => {
    const api = await seedApi((await seedSeller()).id, "priced");
    expect((await call(api.id, null)).status).toBe(401);
    expect((await call(api.id, "wrong")).status).toBe(401);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it("runs the same check as the review page and stores the result", async () => {
    const api = await seedApi((await seedSeller()).id, "priced");
    const op = await seedOperation(api.id, { enabled: true });
    await seedRule(op.id);
    const res = await call(api.id, "test-internal-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ exposure: "protected", message: null, endpoints: [{ opId: "getPrice", exposure: "protected" }] });
    const [row] = await getSql()<{ exposure: string }[]>`select exposure from apis where id = ${api.id}`;
    expect(row.exposure).toBe("protected");
    expect((await call("api_missing", "test-internal-token")).status).toBe(404);
  });
});
