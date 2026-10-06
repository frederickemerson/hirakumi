const API_ID = /^api_[A-Za-z0-9]+$/;

export function parseChallenges(raw: string | undefined, log: (msg: string) => void): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log('HIRAKUMI_CHALLENGE is not JSON. Expected {"api_xxx":"token"}; serving no challenge files');
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log('HIRAKUMI_CHALLENGE must be a JSON object {"api_xxx":"token"}; serving no challenge files');
    return {};
  }
  const out: Record<string, string> = {};
  for (const [apiId, token] of Object.entries(parsed)) {
    if (API_ID.test(apiId) && typeof token === "string" && token.length > 0) out[apiId] = token;
  }
  return out;
}
