import type { UpstreamResult, Verdict } from "@hirakumi/core";

export type PreviewResult = UpstreamResult & { verdict?: Verdict };
export type GatewayClient = {
  preview(apiId: string, opId: string, input: Record<string, unknown>): Promise<PreviewResult>;
};

/** The gateway's DNS ownership check (POST /internal/challenge/:apiId/check), the same one the ownership page asks. */
export type ChallengeReason = "verified" | "no_code" | "bad_host" | "timeout" | "unreachable" | "missing" | "mismatch";
export type ChallengeCheck = { ok: boolean; reason: ChallengeReason; record: string; detail: string };
export type DnsGateway = { checkChallenge(apiId: string): Promise<ChallengeCheck> };

const isPreview = (v: unknown): v is PreviewResult => {
  const r = v as PreviewResult;
  return !!r && typeof r.status === "number" && typeof r.body === "string" && typeof r.latencyMs === "number" &&
    (r.contentType === null || typeof r.contentType === "string");
};

const isCheck = (v: unknown): v is ChallengeCheck => {
  const r = v as ChallengeCheck;
  return !!r && typeof r.ok === "boolean" && typeof r.reason === "string" && typeof r.record === "string" && typeof r.detail === "string";
};

/** Client for the gateway's internal routes (contract: POST /internal/preview/:apiId/:opId). */
export function createGatewayClient(baseUrl: string, internalToken: string, fetchImpl: typeof fetch = fetch): GatewayClient & DnsGateway {
  const post = (path: string, body: unknown) => fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${internalToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return {
    async preview(apiId, opId, input) {
      const res = await post(`/internal/preview/${encodeURIComponent(apiId)}/${encodeURIComponent(opId)}`, { input });
      const text = await res.text();
      if (!res.ok) throw new Error(`Gateway preview for ${opId} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      const json: unknown = JSON.parse(text);
      if (!isPreview(json)) throw new Error(`Gateway preview for ${opId} returned an unexpected shape`);
      return json;
    },
    async checkChallenge(apiId) {
      const res = await post(`/internal/challenge/${encodeURIComponent(apiId)}/check`, {});
      const text = await res.text();
      if (!res.ok) throw new Error(`Gateway DNS check for ${apiId} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      const json: unknown = JSON.parse(text);
      if (!isCheck(json)) throw new Error(`Gateway DNS check for ${apiId} returned an unexpected shape`);
      return json;
    },
  };
}
