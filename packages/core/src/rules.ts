import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { jcs } from "./jcs";
import { sha256Hex } from "./ids";
import type { UpstreamResult } from "./fetch";

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

/**
 * application/json, structured-syntax JSON such as application/vnd.api+json or application/problem+json, and JSON
 * sent as text (text/json, text/x-json, text/*+json): the body is parsed and checked as JSON.
 */
export function isJsonMediaType(ct: string): boolean {
  return ct === "application/json" || /^application\/[a-z0-9.!#$&^_-]+\+json$/.test(ct)
    || ct === "text/json" || ct === "text/x-json" || /^text\/[a-z0-9.!#$&^_-]+\+json$/.test(ct);
}

/** Answers Hirakumi can check as text: text/* (but not JSON sent as text), XML, CSV and YAML. Binary types are not. */
export function isTextMediaType(ct: string): boolean {
  if (isJsonMediaType(ct)) return false;
  return /^text\/[a-z0-9.+-]+$/.test(ct)
    || ct === "application/xml" || /^application\/[a-z0-9.!#$&^_-]+\+xml$/.test(ct)
    || ct === "application/csv" || ct === "application/yaml" || ct === "application/x-yaml";
}

/** Text types whose good answers are markup themselves, so an HTML page is not a sign of an error. */
function isMarkupMediaType(ct: string): boolean {
  return ct === "text/html" || ct === "text/xml" || ct === "application/xml" || /\+xml$/.test(ct);
}

/** The media type of a Content-Type header, lowercased without parameters. */
export function mediaTypeOf(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

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
 * or XML, a body that is an HTML page (a proxy's or framework's error page) breaks it too. When the samples are at
 * least two different bodies, each more than one line, and they all start with the same first line (a CSV header,
 * say), that line is required too; one body repeated (QA calls the same example several times) does not show which
 * line is a header and which is data.
 * The status code is the main signal for an error: a text error ("Rate limit exceeded") sent with a 2xx status
 * passes, so the seller's API must answer errors with a 4xx or 5xx status. An error answer must differ by status,
 * media type or that first line; otherwise this throws.
 */
export function inferTextRule(contentType: string, samples: string[], errorSample?: UpstreamResult): RuleDefinition {
  if (samples.length === 0) throw new Error("inferTextRule needs at least one passing sample");
  const firstLines = samples.map((s) => s.split(/\r?\n/)[0]);
  const header = new Set(samples).size >= 2
    && samples.every((s) => /\r?\n/.test(s.trimEnd())) && firstLines.every((l) => l === firstLines[0]) && firstLines[0].trim()
    ? firstLines[0]
    : null;
  const schema: Record<string, unknown> = { type: "string", minLength: 1, pattern: header ? `^${escapeRegExp(header)}\\r?\\n` : NON_BLANK };
  if (!isMarkupMediaType(contentType)) schema.not = { pattern: HTML_PAGE };
  const def: RuleDefinition = { version: 1, status: { min: 200, max: 299 }, contentType, schema };
  if (errorSample && compileRule(def).check(errorSample).pass) {
    throw new RuleInferenceError("The promise would accept the error response. Make your API answer unknown input with an HTTP 4xx status.");
  }
  return def;
}

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