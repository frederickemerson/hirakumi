import { vi } from "vitest";

export type Recorded = { method: string; url: URL; headers: Record<string, string>; body: unknown };
type Reply = { status?: number; json: unknown };
type Handler = (req: Recorded) => Reply;

/** Replaces global fetch with a router keyed by "METHOD /pathname". Unknown routes answer 404. */
export function installFakeFetch(routes: Record<string, Handler>): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fake = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const req: Recorded = { method: init?.method ?? "GET", url, headers, body };
    calls.push(req);
    const handler = routes[`${req.method} ${url.pathname}`];
    const reply: Reply = handler
      ? handler(req)
      : { status: 404, json: { status: "error", error: { message: `no fake route for ${req.method} ${url.pathname}` } } };
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fake);
  return { calls };
}

export const ok = (data: unknown): Reply => ({ json: { status: "success", data } });
export const fail = (status: number, message: string): Reply => ({ status, json: { status: "error", error: { message } } });
