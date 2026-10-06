const API_ID = /^api_[A-Za-z0-9]+$/;

/**
 * Hirakumi ownership codes for this demo seller, from HIRAKUMI_CHALLENGE = {"api_xxx":"hkv_..."}.
 * The code is served as `x-hirakumi-verify` at the root of /openapi.json. One spec carries one code,
 * so the latest one set wins: the last entry here, or the last one PUT to /admin/challenge/:apiId.
 */
export function parseChallenges(raw: string | undefined, log: (msg: string) => void): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log('HIRAKUMI_CHALLENGE is not JSON. Expected {"api_xxx":"hkv_..."}; serving no verification code');
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log('HIRAKUMI_CHALLENGE must be a JSON object {"api_xxx":"hkv_..."}; serving no verification code');
    return {};
  }
  const out: Record<string, string> = {};
  for (const [apiId, token] of Object.entries(parsed)) {
    if (API_ID.test(apiId) && typeof token === "string" && token.length > 0) out[apiId] = token;
  }
  return out;
}

/** The code to serve: the most recently set one (insertion order), or null when none is set. */
export function latestCode(codes: Record<string, string>): string | null {
  const values = Object.values(codes);
  return values.length ? values[values.length - 1] : null;
}
