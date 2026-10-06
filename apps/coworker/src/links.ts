/** Web routes P2 serves (contract addition). */
export const setupLink = (webBaseUrl: string, setupToken: string) =>
  `${webBaseUrl}/setup?t=${encodeURIComponent(setupToken)}`;
export const apiLink = (webBaseUrl: string, apiId: string) => `${webBaseUrl}/apis/${encodeURIComponent(apiId)}`;
/** Masumi's Sokosumi listing form (spec §5 step 8). */
export const SOKOSUMI_LISTING_FORM = "https://tally.so/r/nPLBaV";
