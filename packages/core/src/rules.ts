import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { jcs } from "./jcs";
import { sha256Hex } from "./ids";
import type { UpstreamResult } from "./fetch";
import { isJsonMediaType, isMarkupMediaType, isTextMediaType, mediaTypeOf } from "./mediaTypes";

export type RuleDefinition = {
  version: 1;
  status: { min: number; max: number };
  /**
   * The media type every good answer has. For a JSON type (application/json or any +json) the schema checks the
   * parsed body; for a text type (isTextMediaType) it checks the body as one JSON string.
   */
  contentType: string;
  schema: Record<string, unknown>;
};

export { isJsonMediaType, isMarkupMediaType, isTextMediaType, mediaTypeOf } from "./mediaTypes";

export type Verdict = { pass: boolean; reasons: string[] };
/** contentType is the promised media type (the gateway asks the upstream for it). */
export type CompiledRule = { hash: string; contentType: string; check(res: UpstreamResult): Verdict };

// Contract v1.1 B2: 600–3000 s. Price feeds such as CoinGecko lag 1–5 min, and a stale demo answer is 1 h old.
export const DEFAULT_MAX_AGE_SECONDS = 900;
const MAX_CLOCK_SKEW_SECONDS = 60;

/** Age in seconds of an ISO 8601 string or an epoch-seconds number; null when unparseable. */
export function ageSeconds(value: string | number, nowMs: number): number | null {
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? (nowMs - ms) / 1000 : null;
}

const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
ajv.addKeyword({
  keyword: "maxAgeSeconds",
  type: ["string", "number"],
  schemaType: "number",
  errors: false,
  // Runs at validation time, so Date.now() is the moment the response is checked.
  validate: (maxAge: number, data: unknown) => {
    const age = ageSeconds(data as string | number, Date.now());
    // A timestamp more than a minute in the future (a far-off date, or epoch ms read as seconds) is not fresh.
    return age !== null && age >= -MAX_CLOCK_SKEW_SECONDS && age <= maxAge;
  },
});

export function ruleHash(def: RuleDefinition): string {
  return `sha256:${sha256Hex(jcs(def))}`;
}

export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const at = e.instancePath || "/";
    if (e.keyword === "required") {
      return `${e.instancePath}/${(e.params as { missingProperty: string }).missingProperty} is missing`;
    }
    if (e.keyword === "maxAgeSeconds") {
      const age = ageSeconds(e.data as string | number, Date.now());
      return age !== null && age < 0 ? `${at} is in the future` : `${at} is older than ${String(e.schema)}s`;
    }
    if (e.keyword === "not") return `${at} looks like an error response`;
    if (e.keyword === "pattern" && e.schema === NON_BLANK) return `${at} is blank`;
    if (e.keyword === "pattern" && /^#\/allOf\/[1-9]\d*\/pattern$/.test(e.schemaPath)) {
      return `${at} does not contain ${JSON.stringify(unescapeRegExp(String(e.schema)))}`;
    }
    return `${at} ${e.message ?? "is invalid"}`;
  });
}

const cache = new Map<string, CompiledRule>();

export function compileRule(def: RuleDefinition): CompiledRule {
  if (def.version !== 1) throw new Error(`unsupported rule version ${String(def.version)}`);
  const hash = ruleHash(def);
  const hit = cache.get(hash);
  if (hit) return hit;
  const validate: ValidateFunction = ajv.compile(def.schema);
  const compiled: CompiledRule = {
    hash,
    contentType: def.contentType,
    check(res: UpstreamResult): Verdict {
      const reasons: string[] = [];
      if (res.status < def.status.min || res.status > def.status.max) {
        reasons.push(`status ${res.status} is outside ${def.status.min}-${def.status.max}`);
      }
      const ct = mediaTypeOf(res.contentType);
      if (ct !== def.contentType) reasons.push(`content type is ${ct || "missing"}, expected ${def.contentType}`);
      if (reasons.length) return { pass: false, reasons };
      let body: unknown = res.body;
      if (isJsonMediaType(def.contentType)) {
        try {
          body = JSON.parse(res.body);
        } catch {
          return { pass: false, reasons: ["body is not valid JSON"] };
        }
      }
      if (validate(body)) return { pass: true, reasons: [] };
      return { pass: false, reasons: formatSchemaErrors(validate.errors) };
    },
  };
  cache.set(hash, compiled);
  return compiled;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
type JsonKind = "null" | "boolean" | "number" | "string" | "array" | "object";

function kindOf(v: unknown): JsonKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "boolean" || t === "number" || t === "string" || t === "object") return t;
  throw new Error(`not a JSON value: ${t}`);
}

/** JSON Schema that every sample satisfies: required = keys present in all samples. */
export function inferSchema(values: unknown[]): Record<string, unknown> {
  const kinds = [...new Set(values.map(kindOf))].sort();
  if (kinds.length !== 1) return { type: kinds };
  const kind = kinds[0];
  if (kind === "object") {
    const objs = values as Record<string, unknown>[];
    const common = Object.keys(objs[0]).filter((k) => objs.every((o) => Object.hasOwn(o, k))).sort();
    return {
      type: "object",
      required: common,
      properties: Object.fromEntries(common.map((k) => [k, inferSchema(objs.map((o) => o[k]))])),
    };
  }
  if (kind === "array") {
    const items = (values as unknown[][]).flat();
    return items.length ? { type: "array", items: inferSchema(items) } : { type: "array" };
  }
  if (kind === "string") {
    const strings = values as string[];
    const now = Date.now();
    const freshStamp = strings.every((s) => {
      if (!ISO_DATE_TIME.test(s)) return false;
      const age = ageSeconds(s, now);
      return age !== null && Math.abs(age) <= DEFAULT_MAX_AGE_SECONDS;
    });
    return freshStamp ? { type: "string", maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS } : { type: "string" };
  }
  return { type: kind };
}

function acceptsBody(def: RuleDefinition, body: unknown): boolean {
  return compileRule(def).check({ status: 200, contentType: "application/json", body: JSON.stringify(body), latencyMs: 0 }).pass;
}

const isObject = (v: unknown): v is Record<string, unknown> => kindOf(v) === "object";

export function inferRule(samples: unknown[], errorSample?: unknown): RuleDefinition {
  if (samples.length === 0) throw new Error("inferRule needs at least one passing sample");
  const base: RuleDefinition = {
    version: 1,
    status: { min: 200, max: 299 },
    contentType: "application/json",
    schema: inferSchema(samples),
  };
  if (errorSample === undefined || !acceptsBody(base, errorSample)) return base;
  if (isObject(errorSample) && samples.every(isObject)) {
    const seen = new Set(samples.flatMap((s) => Object.keys(s)));
    const distinctive = Object.keys(errorSample).filter((k) => !seen.has(k)).sort();
    if (distinctive.length) {
      const tightened: RuleDefinition = {
        ...base,
        schema: { ...base.schema, not: { anyOf: distinctive.map((k) => ({ required: [k] })) } },
      };
      if (!acceptsBody(tightened, errorSample)) return tightened;
    }
  }
  throw new Error(
    "The promise would accept the error response. Add a passing sample that shows the fields a real answer always has.",
  );
}

export class RuleInferenceError extends Error {}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a body with at least one non-whitespace character. */
const NON_BLANK = "\\S";
/** "<!doctype html" or "<html" at the start, after optional whitespace, in any case (patterns take no flags). */
const anyCase = (s: string) => s.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);
const HTML_PAGE = `^\\s*<(?:!${anyCase("doctype")}\\s+${anyCase("html")}|${anyCase("html")})`;

/**
 * The promise for a text answer: the media type, a 2xx status and a body that is not blank. Unless the type is HTML
 * or XML, a body that is an HTML page (a proxy's or framework's error page) breaks it too.
 * The status code is the signal for an error: the words of an answer are not, since a CSV may have an "error"
 * column and a log API answers with stack traces. So the seller's API must answer errors with a 4xx or 5xx status,
 * and an error answer must differ by status or media type; otherwise this throws.
 * No line is pinned on its own, not even a first line every test answer shared: answers gathered within seconds
 * cannot show that a line such as "# build abc123" or "Report 2026-10-07 12:00" stays the same. Such a promise is
 * status-only (isStatusOnlyRule) until the seller confirms a phrase every good answer contains (withRequiredPhrase),
 * and a status-only text listing cannot publish.
 */
export function inferTextRule(contentType: string, samples: string[], errorSample?: UpstreamResult): RuleDefinition {
  if (samples.length === 0) throw new Error("inferTextRule needs at least one passing sample");
  const schema: Record<string, unknown> = { type: "string", minLength: 1, pattern: NON_BLANK };
  if (!isMarkupMediaType(contentType)) schema.not = { pattern: HTML_PAGE };
  const def: RuleDefinition = { version: 1, status: { min: 200, max: 299 }, contentType, schema };
  if (errorSample && compileRule(def).check(errorSample).pass) {
    throw new RuleInferenceError("The promise would accept the error response. Make your API answer unknown input with an HTTP 4xx status.");
  }
  return def;
}

const isTextRule = (def: RuleDefinition) => !isJsonMediaType(def.contentType) && def.schema.type === "string";

/**
 * True for a text promise that checks only the status, the media type, a non-blank body and (for a type that is not
 * markup) that the body is not an HTML page: no pinned header line and no required phrase. Any answer with a 2xx
 * status keeps it, so it cannot be published until the seller adds a phrase (withRequiredPhrase).
 */
export function isStatusOnlyRule(def: RuleDefinition): boolean {
  if (!isTextRule(def)) return false;
  const { type: _type, minLength, pattern, not, ...rest } = def.schema;
  if (Object.keys(rest).length) return false;
  if (minLength !== undefined && !(typeof minLength === "number" && minLength <= 1)) return false;
  if (pattern !== undefined && pattern !== NON_BLANK) return false;
  return not === undefined || jcs(not) === jcs({ pattern: HTML_PAGE });
}

export const MAX_REQUIRED_PHRASE_LENGTH = 200;

/**
 * A phrase as a pattern that matches it in any case: each letter with a lower and an upper case of one character
 * becomes a class with the phrase's own letter first ("Price" is "[Pp][rR][iI][cC][eE]"), anything else is escaped.
 * Patterns take no flags, so this is how the gateway, the buyer and every JSON Schema validator read it alike.
 */
function anyCasePhrase(p: string): string {
  return [...p].map((c) => {
    const lower = c.toLowerCase();
    const upper = c.toUpperCase();
    if (lower === upper || [...lower].length !== 1 || [...upper].length !== 1) return escapeRegExp(c);
    return `[${c}${c === lower ? upper : lower}]`;
  }).join("");
}

/**
 * A copy of a text promise that also requires the body to contain phrase (trimmed, in any case, 1 to 200
 * characters on one line). Each check is one entry of schema.allOf: the existing pattern first, then the phrases.
 * Phrases added before matched their exact case (an escaped phrase); stored promises keep that. Throws
 * RuleInferenceError for a JSON promise or a bad phrase.
 */
export function withRequiredPhrase(def: RuleDefinition, phrase: string): RuleDefinition {
  if (!isTextRule(def)) throw new RuleInferenceError("A required phrase only works for promises on text answers.");
  const p = phrase.trim();
  if (!p) throw new RuleInferenceError("Type the phrase every good answer contains.");
  if (p.length > MAX_REQUIRED_PHRASE_LENGTH) throw new RuleInferenceError(`The phrase can be at most ${MAX_REQUIRED_PHRASE_LENGTH} characters.`);
  if (/[\r\n]/.test(p)) throw new RuleInferenceError("The phrase must be on one line.");
  const { pattern, allOf, ...schema } = def.schema;
  const checks: unknown[] = Array.isArray(allOf) ? [...allOf] : [];
  if (pattern !== undefined) checks.unshift({ pattern });
  else if (!checks.length) checks.push({ pattern: NON_BLANK });
  const added = { pattern: anyCasePhrase(p) };
  if (!checks.some((c) => jcs(c) === jcs(added))) checks.push(added);
  return { ...def, schema: { ...schema, allOf: checks } };
}

/** The phrases withRequiredPhrase added to a text promise, unescaped, in order. */
export function requiredPhrasesOf(def: RuleDefinition): string[] {
  if (!isTextRule(def) || !Array.isArray(def.schema.allOf)) return [];
  return (def.schema.allOf as { pattern?: unknown }[]).slice(1).flatMap((c) => (typeof c?.pattern === "string" ? [unescapeRegExp(c.pattern)] : []));
}

/**
 * The phrase back from its pattern: an escaped character is itself, a two-letter class (anyCasePhrase) is its
 * first letter. Read left to right, so an escaped "[" from an exact-case phrase is never taken for a class.
 */
const unescapeRegExp = (s: string) => s.replace(/\\(.)|\[(.)(.)\]/gsu, (_, escaped?: string, first?: string) => escaped ?? first ?? "");

/**
 * The promise from real answers: JSON types go through inferRule on the parsed bodies (the media type is the one
 * the answers had, so vendor +json types work), text types through inferTextRule. All good answers must share one
 * media type. Throws RuleInferenceError when no rule can be built.
 */
export function inferRuleFromResponses(good: UpstreamResult[], bad?: UpstreamResult | null): RuleDefinition {
  if (good.length === 0) throw new Error("inferRuleFromResponses needs at least one passing answer");
  const types = [...new Set(good.map((r) => mediaTypeOf(r.contentType)))];
  if (types.length !== 1) throw new RuleInferenceError(`The answers came back with different content types (${types.join(", ")}). A promise needs one.`);
  const ct = types[0];
  if (isJsonMediaType(ct)) {
    const samples = good.map((r) => JSON.parse(r.body) as unknown);
    let errorSample: unknown;
    if (bad) {
      try { errorSample = JSON.parse(bad.body); } catch { errorSample = bad.body; }
    }
    let def: RuleDefinition;
    try {
      def = inferRule(samples, errorSample);
    } catch (e) {
      throw new RuleInferenceError((e as Error).message);
    }
    return { ...def, contentType: ct };
  }
  if (isTextMediaType(ct)) return inferTextRule(ct, good.map((r) => r.body), bad ?? undefined);
  throw new RuleInferenceError(`The answers are ${ct || "of no content type"}, which Hirakumi can't check yet. It checks JSON and text (such as CSV, XML or plain text).`);
}

export const SUGGESTED_PHRASE_MIN_LENGTH = 3;
export const SUGGESTED_PHRASE_MAX_LENGTH = 60;
/** Text between tags, in runs of letters, spaces and common punctuation: digits, tabs, line ends and tags split runs. */
const PHRASE_RUN = /[\p{L},.:;'"!?()&/%_+#*@ -]+/gu;
const PHRASE_TRIM = /^[\s,;/&-]+|[\s,;/&-]+$/g;

/**
 * A phrase to suggest as a required phrase for a status-only text promise: the longest run of whole words (letters
 * and common punctuation, no digits, 3 to 60 characters, on one line, at least two letters together) that every good
 * body contains exactly and that the bad body (the answer to a deliberately wrong input) does not contain in any
 * case. Text inside tags is skipped. It is only a suggestion: the seller confirms or changes it before publishing.
 * Ties go to the earliest in the shortest good body. Null when there is none, and when the good bodies are fewer than
 * two different ones: one answer repeated (QA calling one input five times) does not show which words every answer
 * has and which belong to that input ("Cardano (ADA) price today").
 */
export function suggestPhrase(goodBodies: string[], badBody?: string): string | null {
  if (new Set(goodBodies).size < 2) return null;
  const bad = (badBody ?? "").toLowerCase();
  const source = goodBodies.reduce((a, b) => (b.length < a.length ? b : a)).slice(0, 20_000).replace(/<[^>]*>/g, "\n");
  const inAll = new Map<string, boolean>();
  const everywhere = (t: string) => {
    let hit = inAll.get(t);
    if (hit === undefined) inAll.set(t, (hit = goodBodies.every((b) => b.includes(t))));
    return hit;
  };
  let best: string | null = null;
  for (const run of source.match(PHRASE_RUN) ?? []) {
    const words = [...run.matchAll(/\S+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
    for (let i = 0; i < words.length; i++) {
      for (let j = i; j < words.length; j++) {
        const span = run.slice(words[i].start, words[j].end);
        if (span.length > SUGGESTED_PHRASE_MAX_LENGTH + 4 || !everywhere(span)) break;
        const phrase = span.replace(PHRASE_TRIM, "");
        if (phrase.length < SUGGESTED_PHRASE_MIN_LENGTH || phrase.length > SUGGESTED_PHRASE_MAX_LENGTH || (best && phrase.length <= best.length)) continue;
        if (!/\p{L}{2}/u.test(phrase) || bad.includes(phrase.toLowerCase())) continue;
        best = phrase;
      }
    }
  }
  return best;
}
