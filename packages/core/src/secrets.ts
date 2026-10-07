/**
 * Spotting a key, token or password in what a seller typed (a Sokosumi comment, or the example requests of an API
 * without an OpenAPI file). Hirakumi then neither stores nor repeats it, and points the seller at the ownership
 * page, where the key is sealed so only the gateway can read it (upstreamAuth.ts).
 *
 * Crypto APIs take ordinary inputs named like credentials (`token=0x…` is a token contract, `signature=` a
 * transaction signature), so those names count only with a value that has a key's shape and is not an on-chain id.
 */

// Whole names that only ever hold a credential (compared lowercased, without '-', '_' and '.').
const KEY_PARAM_NAMES = new Set([
  "key", "apikey", "xapikey", "apisecret", "apitoken", "accesskey", "accesstoken", "authtoken", "auth", "authorization",
  "appkey", "appid", "appsecret", "clientsecret", "secret", "secretkey", "privatekey", "password", "passwd", "pwd",
  "sessiontoken", "refreshtoken", "idtoken", "bearer",
]);

// Endings of a name without separators that are a credential: x_cg_demo_api_key, CMC_PRO_API_KEY, hapikey,
// Ocp-Apim-Subscription-Key, x-api-token.
const KEY_TAILS = [
  "apikey", "apisecret", "apitoken", "accesskey", "accesstoken", "authkey", "authtoken", "secretkey", "privatekey",
  "subscriptionkey", "clientsecret", "appsecret", "sessiontoken", "refreshtoken", "password", "passwd",
];

// Words of a name (split on - _ . and camelCase) that make it a credential wherever they appear.
const KEY_WORDS = new Set(["secret", "password", "passwd", "authorization", "bearer", "credential", "credentials"]);

// A last word "key" or "auth" counts, except after a word that makes it an ordinary input: public_key, stake_key,
// sort_key, idempotency_key. A last word "token" counts only after a credential word: api_token, id_token, but not
// from_token or base_token. Plural and longer words (keys, keyword, monkey, tokens) are never credentials.
const PUBLIC_KEY_QUALIFIERS = new Set([
  "public", "pub", "verification", "verify", "stake", "staking", "payment", "policy", "sort", "order", "group",
  "partition", "primary", "foreign", "cache", "lookup", "idempotency", "object", "file", "s3", "map", "field",
  "column", "row", "search", "routing", "shard",
]);
const TOKEN_QUALIFIERS = new Set(["api", "access", "auth", "session", "refresh", "id", "bearer", "oauth", "secret", "private", "personal", "app", "client"]);

/** The words of a parameter name, lowercased: x_cg_demo_api_key, xApiKey and APIKey2 give [..., "api", "key"]. */
function nameWords(name: string): string[] {
  return name
    .split(/[-_.]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .map((w) => w.toLowerCase().replace(/\d+$/, ""))
    .filter(Boolean);
}

/** True for a query or path parameter name that is a credential, such as api_key, x_cg_demo_api_key or access_token. */
export function isKeyParamName(name: string): boolean {
  const flat = name.toLowerCase().replace(/[-_.]/g, "");
  if (KEY_PARAM_NAMES.has(flat) || KEY_TAILS.some((t) => flat.endsWith(t))) return true;
  const words = nameWords(name);
  if (words.some((w) => KEY_WORDS.has(w) || (KEY_PARAM_NAMES.has(w) && w !== "key" && w !== "auth" && w !== "appid"))) return true;
  const last = words.at(-1);
  const before = words.at(-2) ?? "";
  if (last === "key" || last === "auth" || last === "appid") return !PUBLIC_KEY_QUALIFIERS.has(before);
  return last === "token" && TOKEN_QUALIFIERS.has(before);
}

// Names that often carry an ordinary value in crypto APIs: only a key-shaped value counts.
const WEAK_NAMES = new Set(["token", "sig", "signature"]);

// A value that is a placeholder, not a real key: YOUR_KEY, <key>, $KEY, xxxx, ****.
const PLACEHOLDER = /^(?:your|my|<|\$|\{|x{4,}|\*{3,}|\.{3})/i;
// A credential word in prose or a header, then ':', '=' or ' is ', then the value. '_' and '-' count as separators
// on the left, so the api_key inside x_cg_demo_api_key is found.
const NAMED_SECRET =
  /(?<![A-Za-z0-9])(api[-_ ]?key|apikey|api[-_ ]?token|access[-_ ]?token|auth[-_ ]?token|auth[-_ ]?key|subscription[-_ ]?key|token|secret|client[-_ ]?secret|password|passwd|x-api-key|authorization)(?![A-Za-z0-9])["']?(?:\s*[:=]\s*|\s+is\s+)["']?(?:bearer\s+)?([A-Za-z0-9_\-.~+/=]{8,})/gi;
// name=value or "name": "value" under any name, judged by isKeyParamName (JSON bodies, headers, query strings).
const NAME_VALUE = /(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]{0,63})["']?\s*[:=]\s*["']?(?:bearer\s+)?([A-Za-z0-9_\-.~+/=]{8,})/gi;
const QUERY_PARAM = /[?&]([A-Za-z0-9_.-]{1,64})=([^&\s#"'`]{8,})/g;
const BEARER = /\bbearer\s+([A-Za-z0-9_\-.~+/=]{12,})/gi;
const KNOWN_FORMATS = [
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/, // Stripe-style
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
];

// On-chain ids: hex (0x addresses, hashes, signatures, and Cardano policy.assetName units), base58 (Solana mints,
// Bitcoin and TRON addresses), bech32 with a known prefix, and names such as vitalik.eth.
const ON_CHAIN_ID = new RegExp([
  /^(?:0x)?[0-9a-f]+(?:\.[0-9a-f]*)?$/.source,
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.source,
  /^(?:addr|addr_test|stake|stake_test|asset|pool|drep|bc|tb|ltc|cosmos|osmo|terra|bnb)1[02-9ac-hj-np-z]{6,}$/.source,
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:eth|ada|sol|bnb|arb|crypto|nft|wallet|dao|x)$/.source,
].join("|"), "i");

// Prose ("api key: required in the header") is words; keys have digits or are long.
const secretish = (v: string) => !PLACEHOLDER.test(v) && (/\d/.test(v) || v.length >= 20);
// For a weak name: long, letters and digits mixed, and not an on-chain id.
const keyShaped = (v: string) => !PLACEHOLDER.test(v) && v.length >= 20 && /\d/.test(v) && /[A-Za-z]/.test(v) && !ON_CHAIN_ID.test(v);

function namedValueIsSecret(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (WEAK_NAMES.has(n)) return keyShaped(value);
  if (isKeyParamName(name)) return secretish(value);
  return false;
}

/** True when the text seems to hold a key, token or password. */
export function looksLikeSecret(text: string): boolean {
  for (const m of text.matchAll(NAMED_SECRET)) if (WEAK_NAMES.has(m[1].toLowerCase()) ? keyShaped(m[2]) : secretish(m[2])) return true;
  for (const m of text.matchAll(NAME_VALUE)) if (namedValueIsSecret(m[1], m[2])) return true;
  for (const m of text.matchAll(QUERY_PARAM)) if (namedValueIsSecret(m[1], m[2])) return true;
  for (const m of text.matchAll(BEARER)) if (secretish(m[1])) return true;
  return KNOWN_FORMATS.some((re) => re.test(text));
}
