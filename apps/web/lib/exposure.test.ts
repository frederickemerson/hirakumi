import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamRedirectError, UpstreamTimeoutError } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import type { Api } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedRule, seedSeller, seedTestInput } from "@/test/factories";
import { checkExposure, exposureRefusal, setExposureFetchForTests } from "./exposure";

/** What the seller's API saw: the leak check must look like a stranger, with no key and not the gateway's agent. */
type Seen = { url: string; headers: IncomingHttpHeaders };

let server: Server | null = null;
let seen: Seen[] = [];
const good = () => JSON.stringify({ price: 0.42, last_updated: new Date().toISOString() });

/** A local API that answers each path with the given status and body. */
async function upstream(answers: Record<string, { status: number; body: string; contentType?: string }>): Promise<string> {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const path = new URL(req.url ?? "/", "http://up").pathname.replace(/^\/api_[^/]+/, "");
    const a = answers[path] ?? { status: 404, body: "not found", contentType: "text/plain" };
    res.writeHead(a.status, { "content-type": a.contentType ?? "application/json" });
    res.end(a.body);
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function apiWith(origin: string, ops: { path: string; enabled?: boolean; input?: Record<string, unknown> }[]): Promise<Api> {
  const seller = await seedSeller();
  const api = await seedApi(seller.id, "priced", { origin });
  for (const [i, o] of ops.entries()) {
    const op = await seedOperation(api.id, { opId: `op${i}`, path: o.path, enabled: o.enabled ?? true });
    await seedRule(op.id);
    if (o.input) await seedTestInput(op.id, o.input);
  }
  return api;
}

async function stored(apiId: string) {
  const [row] = await getSql()<{ exposure: string; exposureCheckedAt: Date | null }[]>`
    select exposure, exposure_checked_at from apis where id = ${apiId}`;
  return row;
}

describe("the leak check", () => {
  beforeEach(async () => {
    await resetDb();
    seen = [];
    // A local http API: the SSRF-safe fetch allows it only with this switch (production never sets it).
    vi.stubEnv("ALLOW_INSECURE_UPSTREAM", "1");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    setExposureFetchForTests(null);
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    server = null;
  });

  it("is open when an endpoint gives a good answer without the key, and says where anyone can call it", async () => {
    const origin = await upstream({ "/price": { status: 200, body: good() } });
    const api = await apiWith(origin, [{ path: "/price", input: { symbol: "ADA" } }]);
    await getSql()`update apis set upstream_auth = ${getSql().json({ in: "header", name: "X-API-Key", sealed: "hks2.x", hint: "WXYZ" })} where id = ${api.id}`;

    const report = (await checkExposure(getSql(), api.id))!;
    expect(report.exposure).toBe("open");
    const url = `${origin}${api.pathPrefix}/price?symbol=ADA`;
    expect(report.endpoints).toEqual([{ opId: "op0", method: "GET", path: "/price", url, exposure: "open", detail: `GET ${url} answered 200` }]);
    expect(exposureRefusal(report)).toBe(
      `Anyone can call this API for free at ${url}, so nobody would pay through Hirakumi. Make your API require a key and add it on this page.`,
    );
    // Called once, with the saved test input, without the key and not as the gateway.
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${api.pathPrefix}/price?symbol=ADA`);
    expect(seen[0].headers["x-api-key"]).toBeUndefined();
    expect(seen[0].headers["user-agent"]).toBe("hirakumi-leak-check/0.1");
    expect(await stored(api.id)).toMatchObject({ exposure: "open", exposureCheckedAt: expect.any(Date) });
  });

  it("sends no part of a key in several parts (hks3), and no accept-encoding, so it calls exactly as a stranger would", async () => {
    const origin = await upstream({ "/price": { status: 401, body: '{"error":"missing key"}' } });
    const api = await apiWith(origin, [{ path: "/price", input: { symbol: "ADA" } }]);
    const bag = { v: 3, parts: [{ in: "header", name: "apikey", hint: "WXYZ" }, { in: "query", name: "project", hint: "" }], sealed: "hks3.x" };
    await getSql()`update apis set upstream_auth = ${getSql().json(bag)} where id = ${api.id}`;

    const report = (await checkExposure(getSql(), api.id))!;
    expect(report.exposure).toBe("protected");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${api.pathPrefix}/price?symbol=ADA`);
    expect(seen[0].headers.apikey).toBeUndefined();
    expect(seen[0].headers["accept-encoding"]).toBeUndefined();
  });

  it("is protected when every endpoint refuses without the key (401, 403, or a 200 that breaks the promise)", async () => {
    const origin = await upstream({
      "/a": { status: 401, body: '{"error":"missing key"}' },
      "/b": { status: 403, body: "forbidden", contentType: "text/plain" },
      "/c": { status: 200, body: "<html>Sign in</html>", contentType: "text/html" },
    });
    const api = await apiWith(origin, [{ path: "/a", input: {} }, { path: "/b", input: {} }, { path: "/c", input: {} }]);
    const report = (await checkExposure(getSql(), api.id))!;
    expect(report.endpoints.map((e) => e.exposure)).toEqual(["protected", "protected", "protected"]);
    expect(report.exposure).toBe("protected");
    expect(exposureRefusal(report)).toBeNull();
    expect((await stored(api.id)).exposure).toBe("protected");
  });

  it("is open when any one endpoint is open, and checks only the endpoints for sale", async () => {
    const origin = await upstream({
      "/locked": { status: 401, body: "{}" },
      "/free": { status: 200, body: good() },
      "/off": { status: 200, body: good() },
    });
    const api = await apiWith(origin, [{ path: "/locked", input: {} }, { path: "/free", input: {} }, { path: "/off", enabled: false, input: {} }]);
    const report = (await checkExposure(getSql(), api.id))!;
    expect(report.exposure).toBe("open");
    expect(report.endpoints.map((e) => e.path).sort()).toEqual(["/free", "/locked"]);
    expect(seen.map((s) => s.url).some((u) => u.includes("/off"))).toBe(false);
  });

  it("is unknown, never protected, when the API can't be reached or answers 5xx, and asks to check again", async () => {
    const origin = await upstream({ "/a": { status: 503, body: "busy" } });
    const api = await apiWith(origin, [{ path: "/a", input: {} }]);
    const busy = (await checkExposure(getSql(), api.id))!;
    expect(busy.exposure).toBe("unknown");
    expect(exposureRefusal(busy)).toBe(
      `We couldn't confirm that your API refuses calls without its key, so it can't be published yet. GET ${origin}${api.pathPrefix}/a answered 503. Check again in a minute.`,
    );
    expect((await stored(api.id)).exposure).toBe("unknown");

    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    const down = (await checkExposure(getSql(), api.id))!;
    expect(down.exposure).toBe("unknown");
    expect(exposureRefusal(down)).toMatch(/could not be reached\. Check again in a minute\.$/);
  });

  it("is unknown on a timeout or a redirect (never followed)", async () => {
    const api = await apiWith("https://price.example.dev", [{ path: "/a", input: {} }]);
    setExposureFetchForTests(async () => { throw new UpstreamTimeoutError("slow"); });
    expect(exposureRefusal((await checkExposure(getSql(), api.id))!)).toMatch(/did not answer within 10 seconds\. Check again/);
    setExposureFetchForTests(async () => { throw new UpstreamRedirectError(302, "https://elsewhere.example/login"); });
    const redirected = (await checkExposure(getSql(), api.id))!;
    expect(redirected.exposure).toBe("unknown");
    expect(exposureRefusal(redirected)).toMatch(/answered with a redirect \(302\)\. Check again/);
  });

  it("is unknown when the saved input can't fill the path, or there is nothing to check", async () => {
    const api = await apiWith("https://price.example.dev", [{ path: "/price/{symbol}" }]);
    const fetcher = vi.fn();
    setExposureFetchForTests(fetcher);
    const report = (await checkExposure(getSql(), api.id))!;
    expect(report.exposure).toBe("unknown");
    expect(fetcher).not.toHaveBeenCalled();
    expect(exposureRefusal(report)).toMatch(/GET \/price\/\{symbol\} could not be called with its saved test input\. Check again/);

    const none = await apiWith("https://price.example.dev", []);
    const empty = (await checkExposure(getSql(), none.id))!;
    expect(empty.exposure).toBe("unknown");
    expect(exposureRefusal(empty)).toMatch(/There is no endpoint to check\./);
  });

  it("never calls outside the API's proven folder or a private address", async () => {
    const api = await apiWith("https://price.example.dev", [{ path: "/{id}", input: { id: ".." } }]);
    const fetcher = vi.fn();
    setExposureFetchForTests(fetcher);
    expect((await checkExposure(getSql(), api.id))!.exposure).toBe("unknown");
    expect(fetcher).not.toHaveBeenCalled();

    vi.stubEnv("ALLOW_INSECURE_UPSTREAM", "0");
    setExposureFetchForTests(null);
    const local = await apiWith("https://127.0.0.1", [{ path: "/a", input: {} }]);
    const blocked = (await checkExposure(getSql(), local.id))!;
    expect(blocked.exposure).toBe("unknown");
  });

  it("is null for an API that is gone", async () => {
    expect(await checkExposure(getSql(), "api_missing")).toBeNull();
  });
});
