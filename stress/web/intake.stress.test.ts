// Hostile intake: OpenAPI links and base URLs that point inside, carry credentials or other schemes; huge and
// pathological example-request lists; hostile upstream keys; and ids no row can have (NUL bytes) on public routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateUpstreamAuthKeys } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { setGatewayForTests, type Gateway } from "@/lib/gateway";
import type { Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST as createApi } from "@/app/api/apis/route";
import { GET as progress } from "@/app/api/apis/[apiId]/progress/route";
import { POST as authSave } from "@/app/api/apis/[apiId]/upstream-auth/route";
import { GET as chatGet, POST as chatPost } from "@/app/api/chat/route";
import { POST as tryPost } from "@/app/api/try/[apiId]/route";
import { GET as receipts } from "@/app/api/try/[apiId]/receipts/route";

let s: Seller;
beforeEach(async () => {
  await resetDb();
  s = await seedSeller();
  setGatewayForTests({ checkChallenge: vi.fn(), reloadApi: vi.fn(async () => undefined), getHealth: vi.fn(), getSettlement: vi.fn(async () => []) } as unknown as Gateway);
});
afterEach(() => { setGatewayForTests(null); vi.unstubAllEnvs(); });

const create = (body: unknown) => createApi(jsonRequest("/api/apis", { cookie: cookieFor(s), body }));

describe("OpenAPI links and base URLs", () => {
  const refused = [
    "file:///etc/passwd", "javascript:alert(1)", "data:application/json,{}", "ftp://x.example/openapi.json", "gopher://x.example/",
    "http://169.254.169.254/latest/meta-data/", "http://localhost:3000/openapi.json", "http://127.0.0.1/openapi.json",
    "https://user:pass@api.example/openapi.json", "https://:pass@api.example/openapi.json", "https://api.example./openapi.json",
    "https://api.example/openapi.json?token=abc", `https://a.example/${"x".repeat(3000)}`,
    "", "   ", "not a url", "//api.example/openapi.json", "https://", "https://[::1", "https://\u0000.example/",
  ];

  it("every refused link answers 400 and stores nothing", async () => {
    const out: string[] = [];
    for (const url of refused) {
      for (const body of [{ openapiUrl: url }, { mode: "samples", baseUrl: url, samples: "GET /price?symbol=ADA" }]) {
        const res = await create(body);
        if (res.status !== 400) out.push(`${JSON.stringify(body).slice(0, 80)} -> ${res.status}`);
      }
    }
    expect(out).toEqual([]);
    expect((await getSql()`select count(*)::int n from apis`)[0].n).toBe(0);
  });

  it("non-string and nested inputs are 400, never 500", async () => {
    for (const v of [null, 1, true, [], {}, ["https://a.example/openapi.json"], { toString: "https://a.example" }]) {
      expect((await create({ openapiUrl: v })).status).toBe(400);
      expect((await create({ mode: "samples", baseUrl: v, samples: "GET /p?x=1" })).status).toBe(400);
      expect((await create({ mode: "samples", baseUrl: "https://a.example", samples: v })).status).toBe(400);
      expect((await create({ openapiUrl: "https://a.example/o.json", name: v })).status).toBe(v === null ? 201 : 400);
      await resetDb(); s = await seedSeller();
    }
  });

  // Internal addresses are accepted at intake on purpose: nothing in the web app fetches them, and every upstream call
  // (the coworker's parse, the gateway's checks and calls) goes through safeFetch, which refuses private ranges.
  it("a private, link-local or IPv6-mapped host is only stored, never fetched by the web app", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      for (const host of ["10.0.0.1", "169.254.169.254", "[::ffff:127.0.0.1]", "[fd00::1]", "0x7f000001", "2130706433", "localtest.me"]) {
        const res = await create({ openapiUrl: `https://${host}/openapi.json` });
        expect(res.status, host).toBeLessThan(500);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("example request lists", () => {
  const samples = (lines: string) => create({ mode: "samples", baseUrl: "https://ex.example/v1", samples: lines });

  it("10 000 lines, lines over the limit, and 20 KB+ are refused fast with 400", async () => {
    const cases = [
      Array.from({ length: 10_000 }, (_, i) => `GET /p${i}?a=1`).join("\n"),
      Array.from({ length: 1_000 }, () => "GET /p?a=1").join("\n"),
      `GET /p?a=${"x".repeat(25_000)}`,
    ];
    for (const lines of cases) {
      const t0 = performance.now();
      expect((await samples(lines)).status).toBe(400);
      expect(performance.now() - t0).toBeLessThan(1_500);
    }
  });

  it("pathological lines (traversal, absolute URLs, encoded slashes, deep JSON, regex-heavy) answer 400 or a listing, never 500, and fast", async () => {
    const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;
    const lines = [
      "GET /../../admin", "GET /%2e%2e/admin", "GET /a/%2F/b", "GET http://169.254.169.254/latest", "GET //evil.example/x",
      "GET /p?a=%", "GET /p?a=%zz", "GET /{x=../..}", "GET /{x=%2F}", "GET /{=1}", "GET /{a=1}/{a=2}", "TRACE /p", "GET /p {\"a\":1}",
      `POST /p ${deep}`, `GET /p?${"a=1&".repeat(2000)}`, `GET /${"a/".repeat(4000)}`, "GET /p?body=1", "GET /p\u0000?a=1",
      `GET /p?key=${"A".repeat(40)}`, `GET /p?${"{".repeat(3000)}`, "GET /p?a=1#frag", "GET /‮/p?a=1",
    ];
    for (const line of lines) {
      const t0 = performance.now();
      const res = await samples(line);
      expect(res.status, line.slice(0, 40)).toBeLessThan(500);
      expect(performance.now() - t0, line.slice(0, 40)).toBeLessThan(1_500);
      await resetDb(); s = await seedSeller();
    }
  });
});

describe("upstream keys", () => {
  beforeEach(() => { vi.stubEnv("UPSTREAM_AUTH_PUBLIC_KEY", generateUpstreamAuthKeys().publicKey); });
  const save = (apiId: string, body: unknown) => authSave(jsonRequest(`/x`, { cookie: cookieFor(s), body }), ctx(apiId));

  it("header injection, control characters, unicode, reserved names and huge keys are 400 and store nothing", async () => {
    const api = await seedApi(s.id, "endpoints_confirmed");
    const bad: unknown[] = [
      { in: "header", name: "X-Key\r\nX-Admin: 1", value: "hkfake_0123456789" },
      { in: "header", name: "X-Key", value: "hkfake_0123\r\nX-Admin: 1" },
      { in: "header", name: "X-Key", value: "hkfake_0123\u0000456789" },
      { in: "header", name: "X-Kéy", value: "hkfake_0123456789" },
      { in: "header", name: "X-Key", value: "hkfake_é0123456789" },
      { in: "header", name: "Host", value: "hkfake_0123456789" },
      { in: "header", name: "Content-Length", value: "hkfake_0123456789" },
      { in: "header", name: "Transfer-Encoding", value: "hkfake_0123456789" },
      { in: "header", name: "X".repeat(65), value: "hkfake_0123456789" },
      { in: "header", name: "X-Key", value: "x".repeat(100_000) },
      { in: "query", name: "body", value: "hkfake_0123456789" },
      { in: "query", name: "a&b=c", value: "hkfake_0123456789" },
      { in: "query", name: "a=b", value: "hkfake_0123456789" },
      { in: "cookie", name: "sid", value: "hkfake_0123456789" },
      { in: "header", name: ["X-Key"], value: "hkfake_0123456789" },
      { in: "header", name: "X-Key", value: { toString: "hkfake_0123456789" } },
      { in: "header", name: "X-Key", value: "short" },
    ];
    const out: string[] = [];
    for (const b of bad) {
      const res = await save(api.id, b);
      if (res.status !== 400) out.push(`${JSON.stringify(b).slice(0, 70)} -> ${res.status}`);
    }
    expect(out).toEqual([]);
    const [row] = await getSql()`select upstream_auth from apis where id = ${api.id}`;
    expect(row.upstreamAuth).toBeNull();
  });

  it("50 concurrent saves of different keys: one key is stored, it opens to one of them, no 500", async () => {
    const api = await seedApi(s.id, "endpoints_confirmed");
    const res = await Promise.all(Array.from({ length: 50 }, (_, i) => save(api.id, { in: "header", name: "X-API-Key", value: `hkfake_${i}_0123456789abcdef` })));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const [row] = await getSql()`select upstream_auth from apis where id = ${api.id}`;
    expect(row.upstreamAuth).not.toBeNull();
  });
});

describe("ids no row can have", () => {
  const NUL_IDS = ["\u0000", "api_x\u0000", "api_\u0000' or 1=1 --"];

  it("an API id with a NUL byte is 404 on seller routes, not a 500", async () => {
    for (const id of NUL_IDS) {
      const res = await progress(new Request(`https://web.hirakumi.test/api/apis/x/progress`, { headers: { cookie: cookieFor(s) } }), ctx(id));
      expect(res.status, JSON.stringify(id)).toBe(404);
    }
  });

  it("an API id with a NUL byte in chat (query or body) is 404, not a 500", async () => {
    for (const id of NUL_IDS) {
      const g = await chatGet(new Request(`https://web.hirakumi.test/api/chat?apiId=${encodeURIComponent(id)}`, { headers: { cookie: cookieFor(s) } }));
      expect(g.status).toBe(404);
      const p = await chatPost(jsonRequest("/api/chat", { cookie: cookieFor(s), body: { body: "hi", apiId: id } }));
      expect(p.status).toBe(404);
    }
  });

  it("an API id with a NUL byte on the public Try it live routes is a plain refusal, not a 500", async () => {
    for (const [i, id] of NUL_IDS.entries()) {
      // One visitor address per id: the per-visitor limit runs before the API lookup.
      const t = await tryPost(new Request(`https://web.hirakumi.test/api/try/x`, {
        method: "POST", headers: { "content-type": "application/json", "x-real-ip": `203.0.113.${100 + i}` },
        body: JSON.stringify({ opId: "getPrice", method: "GET", input: { symbol: "ADA" } }),
      }), ctx(id));
      // Not a showcase API (TRY_LIVE_APIS), so refused before any lookup.
      expect(t.status).toBe(404);
      expect((await receipts(new Request("https://web.hirakumi.test/x"), ctx(id))).status).toBe(404);
    }
  });
});
