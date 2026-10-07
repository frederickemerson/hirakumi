/**
 * What a seller's API runs on, read from the response headers its server already sends. Each rule names a header
 * that the server, framework or host sets itself (Server, X-Powered-By, a host's request id), never the URL.
 * Pure, so the ownership panel can show the evidence and tests can feed it headers.
 */

/** Response headers as undici gives them: lowercase names, a repeated header as an array. */
export type ResponseHeaders = Record<string, string | string[] | undefined>;

/** One platform the headers point to: the recipe id in the ownership panel, and the header that shows it. */
export type PlatformHint = { id: string; evidence: string };

type Rule = { id: string; header: string; test: (value: string) => boolean };

const has = (re: RegExp) => (v: string) => re.test(v);
const any = () => true;

/**
 * Most specific first: the app's own framework, then the host in front of it, then a plain web server. The first
 * hint is the recipe to preselect; an app framework wins because its recipe works on any host.
 */
const RULES: Rule[] = [
  { id: "express", header: "x-powered-by", test: has(/\bexpress\b/i) },
  { id: "nextjs", header: "x-powered-by", test: has(/\bnext\.js\b/i) },
  { id: "nextjs", header: "x-nextjs-cache", test: any },
  { id: "nextjs", header: "x-nextjs-prerender", test: any },
  { id: "fastapi", header: "server", test: has(/^(uvicorn|hypercorn)\b/i) },
  { id: "flask", header: "server", test: has(/^werkzeug\b/i) },
  { id: "vercel", header: "x-vercel-id", test: any },
  { id: "vercel", header: "server", test: has(/^vercel\b/i) },
  { id: "netlify", header: "x-nf-request-id", test: any },
  { id: "netlify", header: "server", test: has(/^netlify\b/i) },
  { id: "cloudflare", header: "cf-ray", test: any },
  { id: "cloudflare", header: "server", test: has(/^cloudflare\b/i) },
  { id: "nginx", header: "server", test: has(/^(nginx|openresty)\b/i) },
];

const MAX_EVIDENCE = 60;

/** Every platform the headers show, most specific first, each once with the first header that showed it. */
export function detectPlatforms(headers: ResponseHeaders): PlatformHint[] {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: PlatformHint[] = [];
  for (const rule of RULES) {
    if (out.some((h) => h.id === rule.id)) continue;
    const raw = lower.get(rule.header);
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value === undefined || !rule.test(value)) continue;
    const evidence = `${rule.header}: ${value}`;
    out.push({ id: rule.id, evidence: evidence.length > MAX_EVIDENCE ? `${evidence.slice(0, MAX_EVIDENCE - 1)}…` : evidence });
  }
  return out;
}
