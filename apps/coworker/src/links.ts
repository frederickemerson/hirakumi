/** Web routes P2 serves (contract addition). */
export const setupLink = (webBaseUrl: string, setupToken: string) =>
  `${webBaseUrl}/setup?t=${encodeURIComponent(setupToken)}`;
/** Moves the task's Sokosumi account to the wallet signed in on the page (apps/web /setup link mode). */
export const linkWalletLink = (webBaseUrl: string, setupToken: string) => `${setupLink(webBaseUrl, setupToken)}&link=1`;
export const apiLink = (webBaseUrl: string, apiId: string) => `${webBaseUrl}/apis/${encodeURIComponent(apiId)}`;
/**
 * Dashboard chat only (an API without a Sokosumi task): a task's comments link to the one-time signing pages
 * (/act/<token>, sokosumi/actLinks.ts) instead.
 */
export const reviewLink = (webBaseUrl: string, apiId: string) => `${apiLink(webBaseUrl, apiId)}/review`;
/** Public pages (apps/web/app/p/[apiId]). */
export const statusPageLink = (webBaseUrl: string, apiId: string) => `${webBaseUrl}/p/${encodeURIComponent(apiId)}`;
export const tryPageLink = (webBaseUrl: string, apiId: string) => `${statusPageLink(webBaseUrl, apiId)}/try`;
/** The Masumi registry entry is an NFT; its agent identifier is policy id + asset name, which Cardanoscan resolves. */
export const registryTokenLink = (agentIdentifier: string) => `https://preprod.cardanoscan.io/token/${encodeURIComponent(agentIdentifier)}`;
/** Masumi's Sokosumi listing form (spec §5 step 8). */
export const SOKOSUMI_LISTING_FORM = "https://tally.so/r/nPLBaV";
