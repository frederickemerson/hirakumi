/** Web routes P2 serves (contract addition). */
export const setupLink = (webBaseUrl: string, setupToken: string) =>
  `${webBaseUrl}/setup?t=${encodeURIComponent(setupToken)}`;
/** Moves the task's Sokosumi account to the wallet signed in on the page (apps/web /setup link mode). */
export const linkWalletLink = (webBaseUrl: string, setupToken: string) => `${setupLink(webBaseUrl, setupToken)}&link=1`;
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

/** The seller-only API pages, which open only for the wallet that owns the API. */
const API_PAGE = /^\/apis\/([^/?#]+)(?:\/(?:ownership|review|overview|endpoints))?\/?$/;

/** The API id when `link` is one of this web app's seller-only API pages, else null. */
export function apiIdOfPageLink(webBaseUrl: string, link: string): string | null {
  let u: URL;
  let base: URL;
  try {
    u = new URL(link);
    base = new URL(webBaseUrl);
  } catch {
    return null;
  }
  if (u.origin !== base.origin) return null;
  const prefix = base.pathname.replace(/\/$/, "");
  if (!u.pathname.startsWith(`${prefix}/`)) return null;
  const m = API_PAGE.exec(u.pathname.slice(prefix.length));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
