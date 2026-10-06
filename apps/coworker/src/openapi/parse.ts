import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPI } from "openapi-types";
import YAML, { YAMLParseError } from "yaml";
import { PermanentError } from "../errors.js";

export class OpenApiError extends PermanentError {}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type InputSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
};
export type OpForLlm = {
  opId: string;
  method: HttpMethod;
  path: string;
  summary: string | null;
  description: string | null;
  parameters: { name: string; in: string; description: string | null }[];
};
export type ParsedOperation = { opId: string; method: HttpMethod; path: string; inputSchema: InputSchema; llm: OpForLlm };
export type SkippedOperation = { method: HttpMethod; path: string; reason: string };
/** serverUrl = servers[0].url with {variables} filled from their defaults, or null when the file has no servers. */
export type ParseResult = { title: string; serverUrl: string | null; operations: ParsedOperation[]; skipped: SkippedOperation[] };

type Json = Record<string, unknown>;
type Param = { name: string; in: string; required?: boolean; description?: string; schema?: Json; example?: unknown; examples?: unknown };

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const TEXT_LIMIT = 1000;

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const clip = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, TEXT_LIMIT) : null);

export function toOpId(operationId: unknown, method: HttpMethod, path: string): string {
  if (typeof operationId === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(operationId)) return operationId;
  const base = typeof operationId === "string" && operationId.trim() ? operationId : `${method}_${path}`;
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return slug || method.toLowerCase();
}

function stableKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`;
  if (isRecord(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}

export function uniqueValues<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = stableKey(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** OpenAPI keeps examples in several places; JSON Schema 2020-12 has one: `examples` (an array). */
function collectExamples(example: unknown, examples: unknown, schema: Json): unknown[] {
  const out: unknown[] = [];
  if (example !== undefined) out.push(example);
  if (isRecord(examples)) for (const e of Object.values(examples)) if (isRecord(e) && e.value !== undefined) out.push(e.value);
  if (Array.isArray(examples)) out.push(...examples);
  if (schema.example !== undefined) out.push(schema.example);
  if (Array.isArray(schema.examples)) out.push(...schema.examples);
  return uniqueValues(out);
}

function withExamples(schema: Json, examples: unknown[], description?: string | null): Json {
  const { example: _drop, ...rest } = schema;
  return { ...rest, ...(description ? { description } : {}), ...(examples.length ? { examples } : {}) };
}

function mergeParams(pathLevel: unknown, opLevel: unknown): Param[] {
  const byKey = new Map<string, Param>();
  for (const list of [pathLevel, opLevel]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) if (isRecord(p) && typeof p.name === "string" && typeof p.in === "string") byKey.set(`${p.in}:${p.name}`, p as Param);
  }
  return [...byKey.values()];
}

function buildInputSchema(params: Param[], requestBody: unknown): { schema: InputSchema } | { reason: string } {
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const p of params) {
    if (p.in === "header" || p.in === "cookie") {
      if (p.required) return { reason: `needs the ${p.in} "${p.name}" (not supported yet)` };
      continue;
    }
    if (p.in !== "query" && p.in !== "path") continue;
    if (p.name === "body") return { reason: `has a parameter named "body", which Hirakumi reserves for the request body` };
    if (!isRecord(p.schema)) return { reason: `parameter "${p.name}" has no schema (not supported yet)` };
    properties[p.name] = withExamples(p.schema, collectExamples(p.example, p.examples, p.schema), clip(p.description));
    if (p.required || p.in === "path") required.push(p.name);
  }
  if (requestBody !== undefined) {
    const rb = isRecord(requestBody) ? requestBody : {};
    const json = isRecord(rb.content) ? rb.content["application/json"] : undefined;
    if (!isRecord(json) || !isRecord(json.schema)) return { reason: "request body is not JSON (not supported yet)" };
    properties.body = withExamples(json.schema, collectExamples(json.example, json.examples, json.schema));
    if (rb.required === true) required.push("body");
  }
  const schema: InputSchema = { type: "object", properties, required, additionalProperties: false };
  if (JSON.stringify(schema).includes('"$ref"')) return { reason: "uses a circular or external schema reference (not supported yet)" };
  return { schema };
}

function requiresAuth(op: Json, doc: Json): boolean {
  const security = op.security ?? doc.security;
  if (!Array.isArray(security) || security.length === 0) return false;
  return !security.some((s) => isRecord(s) && Object.keys(s).length === 0);
}

/** Parses an OpenAPI 3.x document (JSON or YAML text). Never fetches anything: external $refs are not resolved. */
/** servers[0].url with {variables} replaced by their defaults (OpenAPI 3 server object). */
function firstServerUrl(servers: unknown): string | null {
  const first = Array.isArray(servers) ? servers[0] : undefined;
  if (!isRecord(first) || typeof first.url !== "string" || !first.url.trim()) return null;
  const vars = isRecord(first.variables) ? first.variables : {};
  return first.url.trim().replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return isRecord(v) && typeof v.default === "string" ? v.default : whole;
  });
}

export async function parseOpenApi(text: string): Promise<ParseResult> {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    if (e instanceof YAMLParseError) throw new OpenApiError(`Your OpenAPI file could not be read: ${e.message.split("\n")[0]}`);
    throw e;
  }
  if (!isRecord(raw)) throw new OpenApiError("Your OpenAPI file is empty or is not an object.");
  if (typeof raw.swagger === "string") {
    throw new OpenApiError("This is a Swagger 2.0 file. Please convert it to OpenAPI 3.x (for example with swagger2openapi) and try again.");
  }
  if (typeof raw.openapi !== "string" || !raw.openapi.startsWith("3.")) {
    throw new OpenApiError(`Hirakumi needs OpenAPI 3.x, but this file says "openapi": ${JSON.stringify(raw.openapi ?? null)}.`);
  }
  let doc: Json;
  try {
    doc = (await SwaggerParser.validate(raw as OpenAPI.Document, {
      resolve: { external: false },
      dereference: { circular: "ignore" },
    })) as unknown as Json;
  } catch (e) {
    throw new OpenApiError(`Your OpenAPI file is not valid: ${(e as Error).message.split("\n").slice(0, 3).join(" ").trim()}`);
  }
  const operations: ParsedOperation[] = [];
  const skipped: SkippedOperation[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(isRecord(doc.paths) ? doc.paths : {})) {
    if (!isRecord(item)) continue;
    for (const m of METHODS) {
      const op = item[m];
      if (!isRecord(op)) continue;
      const method = m.toUpperCase() as HttpMethod;
      if (requiresAuth(op, doc)) {
        skipped.push({ method, path, reason: "needs authentication (not supported yet)" });
        continue;
      }
      const params = mergeParams(item.parameters, op.parameters);
      const built = buildInputSchema(params, op.requestBody);
      if ("reason" in built) {
        skipped.push({ method, path, reason: built.reason });
        continue;
      }
      const opId = toOpId(op.operationId, method, path);
      if (seen.has(opId)) {
        skipped.push({ method, path, reason: `duplicate operation id "${opId}"` });
        continue;
      }
      seen.add(opId);
      operations.push({
        opId,
        method,
        path,
        inputSchema: built.schema,
        llm: {
          opId,
          method,
          path,
          summary: clip(op.summary),
          description: clip(op.description),
          parameters: params.map((p) => ({ name: p.name, in: p.in, description: clip(p.description) })),
        },
      });
    }
  }
  const info = isRecord(doc.info) ? doc.info : {};
  return { title: clip(info.title) ?? "Untitled API", serverUrl: firstServerUrl(doc.servers), operations, skipped };
}
