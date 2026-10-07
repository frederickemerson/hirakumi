import type { Exposure } from "@hirakumi/core";

/**
 * The leak check (apps/web lib/exposure.ts): each sellable endpoint called once without the seller's key. The web
 * app runs it (POST /api/internal/apis/:apiId/exposure, INTERNAL_TOKEN) so the seller's API sees the web app's
 * address: the coworker shares the gateway's host, whose address an API may let through without a key.
 */
export type LeakEndpoint = { opId: string; method: string; path: string; url: string | null; exposure: Exposure; detail: string };
export type LeakReport = { exposure: Exposure; endpoints: LeakEndpoint[] };
export type LeakCheck = (apiId: string) => Promise<LeakReport>;

const EXPOSURES = new Set(["open", "protected", "unknown"]);

export function createLeakCheck(webBaseUrl: string, internalToken: string, fetchImpl: typeof fetch = fetch): LeakCheck {
  return async (apiId) => {
    const res = await fetchImpl(`${webBaseUrl}/api/internal/apis/${encodeURIComponent(apiId)}/exposure`, {
      method: "POST",
      headers: { authorization: `Bearer ${internalToken}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Leak check for ${apiId} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as Partial<LeakReport>;
    if (!json || !EXPOSURES.has(json.exposure as string) || !Array.isArray(json.endpoints)) {
      throw new Error(`Leak check for ${apiId} returned an unexpected shape`);
    }
    return { exposure: json.exposure as Exposure, endpoints: json.endpoints };
  };
}

/** What the leak check means for publishing, in a comment. Null when every endpoint refused a call without the key. */
export function leakProblem(report: LeakReport): string | null {
  if (report.exposure === "protected") return null;
  const open = report.endpoints.find((e) => e.exposure === "open");
  if (open) {
    return `Anyone can call your API for free at ${open.url ?? `${open.method} ${open.path}`}, so nobody would pay through Hirakumi. ` +
      "Make your API require a key, then add the key here (sealed so only the Hirakumi gateway can read it):";
  }
  const unknown = report.endpoints.find((e) => e.exposure === "unknown");
  return `I couldn't confirm that your API refuses calls without its key${unknown ? ` (${unknown.detail})` : ""}, so it can't be published yet. ` +
    "Reply `publish` in a minute to check again.";
}
