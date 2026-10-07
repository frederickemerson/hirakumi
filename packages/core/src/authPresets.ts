import {
  schemeSecretTooShort, UpstreamAuthError, validateUpstreamAuth, validateUpstreamBag,
  type UpstreamAuthPlacement, type UpstreamCredential, type UpstreamPartPlacement,
} from "./upstreamAuth";

/**
 * The ways a seller can say how their API takes its key. The web app renders what the seller typed into the values
 * the gateway sends, and the list of texts that must never reach a buyer (the leak list). What one header or query
 * parameter can carry is sealed as today (hks2); the rest as a bag of parts (hks3, sealUpstreamBag).
 *
 * - single: one header or query parameter, as typed ({ in, name, value }).
 * - bearer: "Bearer <key>" in Authorization, or another word before the key ("Token", "ApiKey") or another header
 *   ({ key, scheme?, header? }).
 * - basic: HTTP Basic ({ username, password? }). With no password the key is the user name (hks2); with a password,
 *   a bag whose leak list is the password and "user:password", never the user name.
 * - twoHeaders, keyPlusFixed, headerPlusQuery: 2-4 rows ({ rows: PresetRow[] }) of a secret or fixed text each:
 *   two headers, at least one fixed text (a version header), or a header and a query parameter.
 */
export type AuthPresetName = "single" | "bearer" | "basic" | "twoHeaders" | "keyPlusFixed" | "headerPlusQuery";
export const AUTH_PRESETS: readonly AuthPresetName[] = ["single", "bearer", "basic", "twoHeaders", "keyPlusFixed", "headerPlusQuery"];

/**
 * One row of a multi-part preset. A secret row (8 characters or more) is withheld from answers; fixed text is
 * public and sent as typed. `scheme` is a word sent before the value ("Bearer" gives "Bearer <value>").
 */
export type PresetRow = { in: UpstreamAuthPlacement; name: string; value: string; fixed?: boolean; scheme?: string };

/** What each preset takes. */
export type PresetFields = {
  single: { in: UpstreamAuthPlacement; name: string; value: string };
  bearer: { key: string; scheme?: string; header?: string };
  basic: { username: string; password?: string };
  twoHeaders: { rows: PresetRow[] };
  keyPlusFixed: { rows: PresetRow[] };
  headerPlusQuery: { rows: PresetRow[] };
};

/** One key for sealUpstreamSecret (hks2), or a bag's placements and contents for sealUpstreamBag (hks3). */
export type RenderedPreset =
  | { kind: "hks2"; credential: UpstreamCredential }
  | { kind: "hks3"; parts: UpstreamPartPlacement[]; values: string[]; fixed: number[]; leak: string[] };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** A secret the seller typed: 8 characters or more. */
function secret(value: string, what = "key"): string {
  if (value.length < 8) throw new UpstreamAuthError(`That ${what} looks too short. Paste the whole ${what}.`);
  return value;
}

/** The word before a key ("Bearer", "Token", "ApiKey"), or "" for none. */
function scheme(raw: unknown): string {
  const s = str(raw);
  if (s && !/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(s)) {
    throw new UpstreamAuthError("The word before the key can only use letters, digits, '.', '_' and '-', for example Bearer.");
  }
  return s;
}

/** A bag, checked by the gateway's own rules (validateUpstreamBag), with the names and values as they will be sent. */
function bag(parts: UpstreamPartPlacement[], values: string[], fixed: number[], leak: string[]): RenderedPreset {
  const checked = validateUpstreamBag(parts, { values, fixed, leak: [...new Set(leak)] });
  return {
    kind: "hks3",
    parts: checked.parts.map((p) => ({ in: p.in, name: p.name })),
    values: checked.parts.map((p) => p.value),
    fixed,
    leak: [...new Set(leak)],
  };
}

function bearer(f: Record<string, unknown>): RenderedPreset {
  const key = secret(str(f.key));
  if (/\s/.test(key)) throw new UpstreamAuthError("Paste the key on its own, without the word before it.");
  const word = scheme(f.scheme) || "Bearer";
  return { kind: "hks2", credential: validateUpstreamAuth({ in: "header", name: str(f.header) || "Authorization", value: `${word} ${key}` }) };
}

function basic(f: Record<string, unknown>): RenderedPreset {
  const user = str(f.username);
  const password = str(f.password);
  if (user.includes(":")) throw new UpstreamAuthError("The user name can't contain ':'.");
  if (!/^[\x20-\x7e]*$/.test(user + password)) throw new UpstreamAuthError("The user name and password can only contain printable characters.");
  if (!password) {
    // The key is the user name: one header, and the hks2 leak check already covers the user and the pair.
    secret(user);
    return { kind: "hks2", credential: validateUpstreamAuth({ in: "header", name: "Authorization", value: `Basic ${b64(`${user}:`)}` }) };
  }
  secret(password, "password");
  return bag([{ in: "header", name: "Authorization" }], [`Basic ${b64(`${user}:${password}`)}`], [], [password, `${user}:${password}`]);
}

function rows(preset: AuthPresetName, f: Record<string, unknown>): RenderedPreset {
  const list = Array.isArray(f.rows) ? f.rows.map(record) : [];
  if (list.length < 2 || list.length > 4) throw new UpstreamAuthError("Add 2 to 4 parts.");
  const parts: UpstreamPartPlacement[] = [];
  const values: string[] = [];
  const fixed: number[] = [];
  const leak: string[] = [];
  list.forEach((r, i) => {
    if (r.in !== "header" && r.in !== "query") throw new UpstreamAuthError("Choose whether each part goes in a header or a query parameter.");
    const word = scheme(r.scheme);
    const value = str(r.value);
    const sent = word ? `${word} ${value}` : value;
    if (r.fixed === true) fixed.push(i);
    else {
      if (schemeSecretTooShort(value)) throw new UpstreamAuthError("The key after the word before it looks too short. Paste the whole key.");
      leak.push(...new Set([secret(value), sent]));
    }
    parts.push({ in: r.in, name: str(r.name) });
    values.push(sent);
  });
  if (preset === "twoHeaders" && (list.length !== 2 || parts.some((p) => p.in !== "header"))) throw new UpstreamAuthError("Add two headers.");
  if (preset === "keyPlusFixed" && fixed.length === 0) throw new UpstreamAuthError("Mark the part that is fixed text, such as a version.");
  if (preset === "headerPlusQuery" && !(parts.some((p) => p.in === "header") && parts.some((p) => p.in === "query"))) {
    throw new UpstreamAuthError("Add at least one header and one query parameter.");
  }
  return bag(parts, values, fixed, leak);
}

/**
 * Renders what the seller typed for a preset (fields as PresetFields, from untrusted JSON) into one key (hks2) or a
 * bag (hks3), with the leak list: every secret, every sent value with a secret in it ("Bearer <key>"), and for Basic
 * the password and "user:password" (never the user name, never fixed text). Bags pass validateUpstreamBag, so what
 * the web app seals is what the gateway accepts. Throws UpstreamAuthError with a message for the seller.
 */
export function renderPreset(preset: unknown, fields: unknown): RenderedPreset {
  const f = record(fields);
  switch (preset) {
    case "single":
      return { kind: "hks2", credential: validateUpstreamAuth({ in: f.in, name: f.name, value: f.value }) };
    case "bearer":
      return bearer(f);
    case "basic":
      return basic(f);
    case "twoHeaders":
    case "keyPlusFixed":
    case "headerPlusQuery":
      return rows(preset, f);
    default:
      throw new UpstreamAuthError("Choose how your API takes its key.");
  }
}

const JWT = /eyJ[A-Za-z0-9_-]*\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]*/;

/**
 * When a JWT in the value (alone or after "Bearer ") expires, from its "exp" claim, or null when there is no JWT or
 * no expiry. The signature is not checked: this only warns a seller who pasted a short-lived token as a static key.
 */
export function jwtExpiry(value: string): Date | null {
  const m = JWT.exec(value);
  if (!m) return null;
  try {
    const exp = (JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as { exp?: unknown }).exp;
    const at = typeof exp === "number" ? new Date(exp * 1000) : null;
    return at && !Number.isNaN(at.getTime()) ? at : null;
  } catch {
    return null;
  }
}
