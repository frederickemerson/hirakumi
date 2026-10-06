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
/** Patterns take no flags, so a word is matched in any case letter by letter. */
const anyCase = (s: string) => s.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);
/** The HTML not-pattern of rules made before error bodies were refused: still a status-only rule. */
const LEGACY_HTML_PAGE = `^\\s*<(?:!${anyCase("doctype")}\\s+${anyCase("html")}|${anyCase("html")})`;
/**
 * An HTML page or fragment at the start, after optional whitespace: "<!doctype html", "<html", or an "<h1", "<title",
 * "<body" or "<head" tag (a proxy's or framework's error page).
 */
const HTML_PAGE = `^\\s*<(?:!${anyCase("doctype")}\\s+${anyCase("html")}|${anyCase("html")}|(?:${["h1", "title", "body", "head"].map(anyCase).join("|")})(?=[\\s>/]))`;
/** A body shorter than this that starts with an error phrase is an error page, whatever its status. */
export const ERROR_BODY_MAX_LENGTH = 199;
const ERROR_PHRASES = [
  "internal server error", "internal error", "error", "rate limit exceeded", "rate limited", "rate limit", "too many requests",
  "service unavailable", "bad gateway", "gateway timeout", "gateway time-out", "not found", "forbidden", "unauthorized",
  "unauthorised", "maintenance", "timeout", "timed out",
];
/**
 * A short error text: after optional whitespace, leading tags and an HTTP status ("404 Not Found", "HTTP/1.1 503
 * Service Unavailable"), one of ERROR_PHRASES as a whole word. "Errors: 0" and "error_count" do not match.
 */
const ERROR_BODY = `^\\s*(?:<[^>]{0,200}>\\s*)*(?:${anyCase("http")}(?:\\/[0-9.]+)?\\s+)?(?:[45][0-9][0-9](?:\\s*[-:.]\\s*|\\s+))?`
  + `(?:${ERROR_PHRASES.map((p) => p.split(" ").map(anyCase).join("\\s+")).join("|")})(?![A-Za-z0-9_])`;

/**
 * What a text promise refuses whatever the status: an HTML page (unless the promised type is HTML or XML, whose good
 * answers are markup) and a short error text. Both sit in one `not: { anyOf: [...] }`.
 */
function errorBodyNot(contentType: string): Record<string, unknown> {
  const shortError = { maxLength: ERROR_BODY_MAX_LENGTH, pattern: ERROR_BODY };
  return { anyOf: isMarkupMediaType(contentType) ? [shortError] : [{ pattern: HTML_PAGE }, shortError] };
}

// A first line that changes between answers is data, not a header: a date, a time or a number in it.
const DATE_OR_TIME = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}:\d{2}/;
const NUMBER_TOKEN = /^[+\-.,%\d]*\d[+\-.,%\d]*$/;
const MAX_HEADER_LENGTH = 300;

/** True when a shared first line can be a header: short enough, with no date, time or standalone number in it. */
function headerLike(line: string): boolean {
  if (!line.trim() || line.length > MAX_HEADER_LENGTH || DATE_OR_TIME.test(line)) return false;
  const tokens = line.split(/[\s,;|\t]+/).map((t) => t.replace(/^["']+|["']+$/g, "")).filter(Boolean);
  return !tokens.some((t) => NUMBER_TOKEN.test(t));
}

/**
 * The promise for a text answer: the media type, a 2xx status, a body that is not blank, and no error body
 * (errorBodyNot): an HTML page unless the type is HTML or XML, or a short text such as "Rate limit exceeded" or
 * "404 Not Found". When the samples are at least two different bodies, each more than one line, and they all start
 * with the same first line (a CSV header, say) with no date, time or number in it, that line is required too; one
 * body repeated (QA calls the same example several times) does not show which line is a header and which is data.
 * An error answer must still differ by status, media type, that first line or an error body; otherwise this throws.
 */
export function inferTextRule(contentType: string, samples: string[], errorSample?: UpstreamResult): RuleDefinition {
  if (samples.length === 0) throw new Error("inferTextRule needs at least one passing sample");
  const firstLines = samples.map((s) => s.split(/\r?\n/)[0]);
  const header = new Set(samples).size >= 2
    && samples.every((s) => /\r?\n/.test(s.trimEnd())) && firstLines.every((l) => l === firstLines[0]) && headerLike(firstLines[0])
    ? firstLines[0]
    : null;
  const schema: Record<string, unknown> = {
    type: "string", minLength: 1, pattern: header ? `^${escapeRegExp(header)}\\r?\\n` : NON_BLANK, not: errorBodyNot(contentType),
  };
  const def: RuleDefinition = { version: 1, status: { min: 200, max: 299 }, contentType, schema };
  if (errorSample && compileRule(def).check(errorSample).pass) {
    throw new RuleInferenceError("The promise would accept the error response. Make your API answer unknown input with an HTTP 4xx status.");
  }
  return def;
}

const isTextRule = (def: RuleDefinition) => !isJsonMediaType(def.contentType) && def.schema.type === "string";

/**
 * True for a text promise that checks only the status, the media type, a non-blank body and error bodies: no
 * pinned header line and no required phrase. Such a promise is kept by any answer that is not an error, so the
 * seller may want to add a phrase (withRequiredPhrase).
 */
export function isStatusOnlyRule(def: RuleDefinition): boolean {
  if (!isTextRule(def)) return false;
  const { type: _type, minLength, pattern, not, ...rest } = def.schema;
  if (Object.keys(rest).length) return false;
  if (minLength !== undefined && !(typeof minLength === "number" && minLength <= 1)) return false;
  if (pattern !== undefined && pattern !== NON_BLANK) return false;
  if (not === undefined) return true;
  const known = [errorBodyNot(def.contentType), { pattern: LEGACY_HTML_PAGE }].map((n) => jcs(n));
  return known.includes(jcs(not));
}

export const MAX_REQUIRED_PHRASE_LENGTH = 200;

/**
 * A copy of a text promise that also requires the body to contain phrase (trimmed, matched exactly, 1 to 200
 * characters on one line). Each check is one entry of schema.allOf: the existing pattern first, then the phrases.
 * Throws RuleInferenceError for a JSON promise or a bad phrase.
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
  const added = { pattern: escapeRegExp(p) };
  if (!checks.some((c) => jcs(c) === jcs(added))) checks.push(added);
  return { ...def, schema: { ...schema, allOf: checks } };
}

/** The phrases withRequiredPhrase added to a text promise, unescaped, in order. */
export function requiredPhrasesOf(def: RuleDefinition): string[] {
  if (!isTextRule(def) || !Array.isArray(def.schema.allOf)) return [];
  return (def.schema.allOf as { pattern?: unknown }[]).slice(1).flatMap((c) => (typeof c?.pattern === "string" ? [unescapeRegExp(c.pattern)] : []));
}

const unescapeRegExp = (s: string) => s.replace(/\\(.)/g, "$1");

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