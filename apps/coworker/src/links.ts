/** Web routes P2 serves (contract addition). */
export const setupLink = (webBaseUrl: string, setupToken: string) =>
  `${webBaseUrl}/setup?t=${encodeURIComponent(setupToken)}`;
export const apiLink = (webBaseUrl: string, apiId: string) => `${webBaseUrl}/apis/${encodeURIComponent(apiId)}`;
/** The wallet steps: each deep link opens exactly that step (apps/web/app/apis/[apiId]/<step>/page.tsx). */
export const ownershipLink = (webBaseUrl: string, apiId: string) => `${apiLink(webBaseUrl, apiId)}/ownership`;
export const reviewLink = (webBaseUrl: string, apiId: string) => `${apiLink(webBaseUrl, apiId)}/review`;
/** A registering or live API's page, which also has its key form. */
export const overviewLink = (webBaseUrl: string, apiId: string) => `${apiLink(webBaseUrl, apiId)}/overview`;
/** Public pages (apps/web/app/p/[apiId]). */
export const statusPageLink = (webBaseUrl: string, apiId: string) => `${webBaseUrl}/p/${encodeURIComponent(apiId)}`;
export const tryPageLink = (webBaseUrl: string, apiId: string) => `${statusPageLink(webBaseUrl, apiId)}/try`;
/** The Masumi registry entry is an NFT; its agent identifier is policy id + asset name, which Cardanoscan resolves. */
export const registryTokenLink = (agentIdentifier: string) => `https://preprod.cardanoscan.io/token/${encodeURIComponent(agentIdentifier)}`;
/** Masumi's Sokosumi listing form (spec §5 step 8). */
export const SOKOSUMI_LISTING_FORM = "https://tally.so/r/nPLBaV";
