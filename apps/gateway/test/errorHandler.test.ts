import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/http";

function app() {
  const a = express();
  a.use(express.json({ limit: "1kb" }));
  a.post("/x", (_req, res) => { res.json({ ok: true }); });
  a.get("/boom", () => { throw new Error("boom"); });
  a.use(errorHandler);
  return a;
}

describe("errorHandler", () => {
  it("answers a body the client sent wrong with its 4xx, not a 500", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const charset = await request(app()).post("/x").set("content-type", "application/json; charset=latin1").send('{"a":1}');
    expect(charset.status).toBe(415);
    expect(charset.body).toEqual({ error: "charset.unsupported" });
    const encoding = await request(app()).post("/x").set("content-type", "application/json").set("content-encoding", "br").send('{"a":1}');
    expect(encoding.status).toBe(415);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("keeps the named answers for bad JSON and large bodies, and 500 for our own errors", async () => {
    expect((await request(app()).post("/x").set("content-type", "application/json").send("{")).body).toEqual({ error: "invalid_json" });
    expect((await request(app()).post("/x").set("content-type", "application/json").send(JSON.stringify({ a: "x".repeat(2000) }))).status).toBe(413);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await request(app()).get("/boom")).status).toBe(500);
    err.mockRestore();
  });
});
