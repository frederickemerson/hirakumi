import type { UpstreamResult, Verdict } from "@hirakumi/core";

export type PreviewResult = UpstreamResult & { verdict?: Verdict };
export type GatewayClient = {
  preview(apiId: string, opId: string, input: Record<string, unknown>): Promise<PreviewResult>;
};

const isPreview = (v: unknown): v is PreviewResult => {
  const r = v as PreviewResult;
  return !!r && typeof r.status === "number" && typeof r.body === "string" && typeof r.latencyMs === "number" &&
    (r.contentType === null || typeof r.contentType === "string");
};

/** Client for the gateway's internal routes (contract: POST /internal/preview/:apiId/:opId). */
export function createGatewayClient(baseUrl: string, internalToken: string, fetchImpl: typeof fetch = fetch): GatewayClient {
  return {
    async preview(apiId, opId, input) {
      const res = await fetchImpl(`${baseUrl}/internal/preview/${encodeURIComponent(apiId)}/${encodeURIComponent(opId)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${internalToken}`, "content-type": "application/json" },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Gateway preview for ${opId} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      const json: unknown = JSON.parse(text);
      if (!isPreview(json)) throw new Error(`Gateway preview for ${opId} returned an unexpected shape`);
      return json;
    },
  };
}
