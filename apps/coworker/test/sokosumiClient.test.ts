import { afterEach, describe, expect, it } from "vitest";
import { createSokosumiClient, SokosumiHttpError } from "../src/sokosumi/client.js";
import { startFakeServer, type FakeServer } from "./helpers/fakeHttp.js";

let server: FakeServer | undefined;
afterEach(async () => server?.close());
const meta = (nextCursor: string | null) => ({ timestamp: "t", requestId: "r", pagination: { cursor: null, limit: 50, total: 1, nextCursor } });

describe("Sokosumi client", () => {
  it("reads /v1/coworkers/me/events with bearer auth, limit and cursor", async () => {
    server = await startFakeServer((req) =>
      req.url.startsWith("/v1/coworkers/me/events")
        ? { status: 200, body: { data: [{ id: "evt_1", taskId: "tsk_1", createdAt: "t", actor: { type: "user", id: "user_1" } }], meta: meta("evt_0") } }
        : undefined,
    );
    const soko = createSokosumiClient({ apiUrl: server.url, apiKey: "coworker_key" });
    const page = await soko.listEvents({ limit: 50, cursor: "evt_9" });
    expect(page).toEqual({ events: [{ id: "evt_1", taskId: "tsk_1", createdAt: "t", actor: { type: "user", id: "user_1" } }], nextCursor: "evt_0" });
    expect(server.calls[0].url).toBe("/v1/coworkers/me/events?limit=50&cursor=evt_9");
    expect(server.calls[0].headers.authorization).toBe("Bearer coworker_key");
  });

  it("posts task events on channel SOKOSUMI and usage with the verified body", async () => {
    server = await startFakeServer((req) => {
      if (req.method === "POST" && req.url === "/v1/tasks/tsk_1/events") return { status: 201, body: { data: { id: "evt_2" }, meta: meta(null) } };
      if (req.method === "POST" && req.url === "/v1/coworkers/me/usage") return { status: 201, body: { data: { id: "ous_1" }, meta: meta(null) } };
      return undefined;
    });
    const soko = createSokosumiClient({ apiUrl: server.url, apiKey: "k" });
    await soko.createTaskEvent("tsk_1", { status: "INPUT_REQUIRED", comment: "hello" });
    await soko.reportUsage({ userId: "user_1", organizationId: null, idempotencyKey: "usage:tsk_1:onboarding", credits: 1500, referenceId: "api_1" });
    expect(server.calls[0].body).toEqual({ status: "INPUT_REQUIRED", comment: "hello", channel: "SOKOSUMI" });
    expect(server.calls[1].body).toEqual({ userId: "user_1", organizationId: null, idempotencyKey: "usage:tsk_1:onboarding", credits: 1500, referenceId: "api_1" });
  });

  it("raises SokosumiHttpError with the status and Sokosumi's message", async () => {
    server = await startFakeServer(() => ({ status: 409, body: { error: "Conflict", message: "Invalid status transition" } }));
    const err = await createSokosumiClient({ apiUrl: server.url, apiKey: "k" }).createTaskEvent("tsk_1", { status: "RUNNING", comment: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(SokosumiHttpError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Invalid status transition/);
  });
});
