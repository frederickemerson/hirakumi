/**
 * The featured APIs that Hirakumi's demo wallet buys live packs for. Same variable and default as the
 * gateway (TRY_LIVE_APIS), which enforces it; the web reads it only to decide whether to offer the button.
 */
export const DEFAULT_TRY_LIVE_APIS = ["api_eejiaioyqt"];

export function tryLiveApis(raw: string | undefined = process.env.TRY_LIVE_APIS): string[] {
  if (raw === undefined) return [...DEFAULT_TRY_LIVE_APIS];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

export function isLiveBuyApi(apiId: string, raw: string | undefined = process.env.TRY_LIVE_APIS): boolean {
  return tryLiveApis(raw).includes(apiId);
}
