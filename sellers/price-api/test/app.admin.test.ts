import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeApp, ADMIN } from "./helpers.js";
import { memoryModeStore } from "../src/modeStore.js";

const auth = { Authorization: `Bearer ${ADMIN}` };

describe("/admin/break", () => {
  it("401 without the right bearer token", async () => {
    const app = makeApp();
    expect((await request(app).post("/admin/break").send({ mode: "empty" })).status).toBe(401);
    expect((await request(app).post("/admin/break").set({ Authorization: "Bearer nope" }).send({ mode: "empty" })).status).toBe(401);
  });

  it("503 when ADMIN_TOKEN is not configured (never an open switch)", async () => {
    const res = await request(makeApp({ adminToken: undefined })).post("/admin/break").set(auth).send({ mode: "empty" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("admin_disabled");
  });

  it("400 on an unknown mode", async () => {
    const res = await request(makeApp()).post("/admin/break").set(auth).send({ mode: "explode" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_mode");
  });

  it("GET reports the current mode and store kind", async () => {
    const app = makeApp();
    await request(app).post("/admin/break").set(auth).send({ mode: "stale" }).expect(200, { mode: "stale" });
    expect((await request(app).get("/admin/break").set(auth)).body).toEqual({ mode: "stale", store: "memory" });
  });

  it("two app instances sharing one store see the same mode (Vercel multi-instance)", async () => {
    const shared = memoryModeStore();
    const a = makeApp({ modes: shared });
    const b = makeApp({ modes: shared });
    await request(a).post("/admin/break").set(auth).send({ mode: "empty" }).expect(200);
    expect((await request(b).get("/price?symbol=ADA")).body).toEqual({});
  });

  it("healthz names the store so the deploy smoke test can catch memory on Vercel", async () => {
    expect((await request(makeApp()).get("/healthz")).body).toEqual({ ok: true, modeStore: "memory" });
  });
});
