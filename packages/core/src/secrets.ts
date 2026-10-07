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

/**
 * True for a name that is a credential and nothing else (api_key, apikey, access_token, client_secret, password,
 * x_cg_demo_api_key): any value of 8 or more characters under it is treated as a key. Shorter, generic names that
 * isKeyParamName also accepts (key, auth, appid, use_auth, basic_auth) are ambiguous: key=BTC is a ticker.
 */
export function isUnambiguousKeyParamName(name: string): boolean {
  if (!isKeyParamName(name)) return false;
  const flat = name.toLowerCase().replace(/[-_.]/g, "");
  if (KEY_TAILS.some((t) => flat.endsWith(t))) return true;
  const words = nameWords(name);
  if (words.some((w) => KEY_WORDS.has(w))) return true;
  if (KEY_PARAM_NAMES.has(flat)) return !AMBIGUOUS_FLAT_NAMES.has(flat);
  // A credential word inside a longer name (x-api-token, my_access_token): only "key", "auth" and "appid" are generic.
  return words.some((w) => KEY_PARAM_NAMES.has(w) && !AMBIGUOUS_FLAT_NAMES.has(w)) || words.at(-1) === "token";
}
const AMBIGUOUS_FLAT_NAMES = new Set(["key", "auth", "appid", "appkey", "pwd"]);

// Names that often carry an ordinary value in crypto APIs: only a key-shaped value counts.
const WEAK_NAMES = new Set(["token", "sig", "signature"]);

// A value that is a placeholder, not a real key: YOUR_KEY, <key>, $KEY, xxxx, ****.
const PLACEHOLDER = /^(?:your|my|<|\$|\{|x{4,}|\*{3,}|\.{3})/i;
// A credential word in prose or a header, then ':', '=' or ' is ', then the value. '_' and '-' count as separators
// on the left, so the api_key inside x_cg_demo_api_key is found.
const NAMED_SECRET =
  /(?<![A-Za-z0-9])(api[-_ ]?key|apikey|api[-_ ]?token|access[-_ ]?token|auth[-_ ]?token|auth[-_ ]?key|subscription[-_ ]?key|token|secret|client[-_ ]?secret|password|passwd|x-api-key|authorization)(?![A-Za-z0-9])["']?(?:\s*[:=]\s*|\s+is\s+)["']?(?:bearer\s+)?([A-Za-z0-9_\-.~+/=]{8,})/gi;
// name=value or "name": "value" under any name, judged by paramHoldsSecret (JSON bodies, headers, query strings).
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
const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BECH32_ID = /^(?:addr|addr_test|stake|stake_test|asset|pool|drep|bc|tb|ltc|cosmos|osmo|terra|bnb)1[02-9ac-hj-np-z]{6,}$/i;
const NAME_ID = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:eth|ada|sol|bnb|arb|crypto|nft|wallet|dao|x)$/i;
const ON_CHAIN_ID = new RegExp([/^(?:0x)?[0-9a-f]+(?:\.[0-9a-f]*)?$/i.source, BASE58_ID.source, BECH32_ID.source, NAME_ID.source].join("|"), "i");
// The same for a value under any name, where a bare 32-character hex string is more likely a key (OpenWeather's
// appid) than an id: hex counts as an on-chain id with 0x, with a dot, or 40 characters or more (addresses, hashes).
const onChainIdAnyName = (v: string) =>
  /^0x[0-9a-f]+$/i.test(v) || /^[0-9a-f]+\.[0-9a-f]*$/i.test(v) || /^[0-9a-f]{40,}$/i.test(v)
  || BASE58_ID.test(v) || BECH32_ID.test(v) || NAME_ID.test(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Prose ("api key: required in the header") is words; keys have digits or are long.
const secretish = (v: string) => !PLACEHOLDER.test(v) && (/\d/.test(v) || v.length >= 20);
// For a weak name: long, letters and digits mixed, and not an on-chain id.
const keyShaped = (v: string) => !PLACEHOLDER.test(v) && v.length >= 20 && /\d/.test(v) && /[A-Za-z]/.test(v) && !ON_CHAIN_ID.test(v);

// Key prefixes seen in the wild: live_…, test_…, sk-…, sk_…, pk_…, rk_… followed by a random part with a digit.
const KEY_PREFIX = /^(?:live|test|sk|pk|rk)[-_](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{12,}$/i;

/** Times the value switches between a letter and a digit: random keys switch often, words and dates rarely. */
function letterDigitSwitches(v: string): number {
  let n = 0;
  let prev: "l" | "d" | null = null;
  for (const ch of v) {
    const kind = /\d/.test(ch) ? "d" : /[A-Za-z]/.test(ch) ? "l" : null;
    if (kind && prev && kind !== prev) n++;
    if (kind) prev = kind;
  }
  return n;
}

/**
 * True when a value has a key's shape whatever its name: a known key format or prefix (sk_live_…, live_…, ghp_…,
 * a JWT, AKIA…), or 16 characters or more of letters and digits mixed like random text, that is not a UUID or an
 * on-chain id. "?k=7f3a9c1e0b2d4f6a8c9e1b3d5f7a9c2e" and "?x=live_8aK2pQ7rT9vW1yZ3" are keys; "bitcoin-cash",
 * "BTCUSDT2024" and a transaction hash are not.
 */
export function valueLooksLikeKey(value: string): boolean {
  const v = value.trim();
  if (PLACEHOLDER.test(v)) return false;
  if (KNOWN_FORMATS.some((re) => re.test(v)) || KEY_PREFIX.test(v)) return true;
  if (v.length < 16 || !/^[A-Za-z0-9_\-+/=]+$/.test(v) || !/\d/.test(v) || !/[A-Za-z]/.test(v)) return false;
  if (UUID.test(v) || onChainIdAnyName(v)) return false;
  return letterDigitSwitches(v) >= 6;
}

// Last words of a name whose values are ids, not keys, even when random-looking: hashes, addresses, cursors.
const ID_WORDS = new Set([
  "id", "ids", "hash", "address", "addr", "tx", "txid", "txhash", "uuid", "guid", "unit", "asset", "mint", "contract", "policy",
  "cursor", "next", "after", "before", "offset", "etag", "page", "pubkey",
]);

/** For an ambiguous key name (key, appid, auth): a value that looks like a key, not a ticker, word or small number. */
function ambiguousValueIsSecret(v: string): boolean {
  if (PLACEHOLDER.test(v)) return false;
  if (/^\d+$/.test(v)) return v.length >= 9;
  // Words: btc, true, bitcoin-cash. One run of 20 letters or more is not a word.
  if (/^[A-Za-z]+(?:[-_.][A-Za-z]+)+$/.test(v) || /^[A-Za-z]{1,19}$/.test(v)) return false;
  return (v.length >= 12 && /\d/.test(v) && /[A-Za-z]/.test(v)) || v.length >= 20;
}

/**
 * True when name=value holds a credential: a value with a key's shape under any name that is not an id
 * (valueLooksLikeKey), a key-shaped value under a weak crypto name (token, sig, signature), any value of 8 or more
 * characters under an unambiguous credential name (isUnambiguousKeyParamName) unless it is a placeholder such as
 * YOUR_KEY, and under an ambiguous one (key,
 * appid, auth) a value that does not look like a ticker, word or small number. key=BTC, appid=12 and
 * use_auth=true are not credentials.
 */
export function paramHoldsSecret(name: string, value: string): boolean {
  const n = name.toLowerCase();
  const words = nameWords(name);
  const last = words.at(-1) ?? "";
  const idName = ID_WORDS.has(last) || (last === "key" && PUBLIC_KEY_QUALIFIERS.has(words.at(-2) ?? ""));
  if (WEAK_NAMES.has(n)) return keyShaped(value) || KNOWN_FORMATS.some((re) => re.test(value));
  if (!idName && valueLooksLikeKey(value)) return true;
  if (isUnambiguousKeyParamName(name)) return value.trim().length >= 8 && !PLACEHOLDER.test(value.trim());
  if (isKeyParamName(name)) return ambiguousValueIsSecret(value.trim());
  return false;
}

/** True when the text seems to hold a key, token or password. */
export function looksLikeSecret(text: string): boolean {
  for (const m of text.matchAll(NAMED_SECRET)) if (WEAK_NAMES.has(m[1].toLowerCase()) ? keyShaped(m[2]) : secretish(m[2])) return true;
  for (const m of text.matchAll(NAME_VALUE)) if (paramHoldsSecret(m[1], m[2])) return true;
  for (const m of text.matchAll(QUERY_PARAM)) if (paramHoldsSecret(m[1], m[2])) return true;
  for (const m of text.matchAll(BEARER)) if (secretish(m[1])) return true;
  return KNOWN_FORMATS.some((re) => re.test(text));
}
