import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { jcs } from "./jcs";
import { sha256Hex } from "./ids";
import type { UpstreamResult } from "./fetch";

export type RuleDefinition = {
  version: 1;
  status: { min: number; max: number };
  contentType: "application/json";
  schema: Record<string, unknown>;
};
export type Verdict = { pass: boolean; reasons: string[] };
export type CompiledRule = { hash: string; check(res: UpstreamResult): Verdict };

export const DEFAULT_MAX_AGE_SECONDS = 300;

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
    return age !== null && age <= maxAge;
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
    if (e.keyword === "maxAgeSeconds") return `${at} is older than ${String(e.schema)}s`;
    if (e.keyword === "not") return `${at} looks like an error response`;
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
    check(res: UpstreamResult): Verdict {
      const reasons: string[] = [];
      if (res.status < def.status.min || res.status > def.status.max) {
        reasons.push(`status ${res.status} is outside ${def.status.min}-${def.status.max}`);
      }
      const ct = (res.contentType ?? "").split(";")[0].trim().toLowerCase();
      if (ct !== def.contentType) reasons.push(`content type is ${ct || "missing"}, expected ${def.contentType}`);
      if (reasons.length) return { pass: false, reasons };
      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        return { pass: false, reasons: ["body is not valid JSON"] };
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
