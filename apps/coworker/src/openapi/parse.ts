import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPI } from "openapi-types";
import YAML, { YAMLParseError } from "yaml";
import { firstServerUrl, MAX_UPSTREAM_PARTS, unsafePathReason, UpstreamAuthError, validateUpstreamAuth } from "@hirakumi/core";
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
/** needsKey: the operation is only callable with the API's key (the gateway adds it, see AuthHint). */
export type ParsedOperation = { opId: string; method: HttpMethod; path: string; inputSchema: InputSchema; llm: OpForLlm; needsKey: boolean };
export type SkippedOperation = { method: HttpMethod; path: string; reason: string };
/** One place the API reads (part of) its key. prefix goes before the key in the value, e.g. "Bearer " for http bearer. */
export type AuthPart = { in: "header" | "query"; name: string; prefix?: string };
/**
 * Where the API reads its key, from the file's security schemes, for the seller's key form (onboard_steps
 * parse output `authHint`). Hirakumi keeps one key per API, so this is the requirement most operations use.
 * A requirement of several schemes at once (an app id and a key, say) has `parts`, 2 to 4 of them, sent together as a
 * key in several parts (hks3); in, name and prefix are then the first part's, so a reader that only knows one part
 * still points the seller at a real one.
 */
export type AuthHint = AuthPart & { parts?: AuthPart[] };
/** parseOpenApi options. multiPartKeys: endpoints that need several keys at once can be sold (UPSTREAM_AUTH_V3). */
export type ParseOptions = { multiPartKeys?: boolean };
/** serverUrl = servers[0].url with {variables} filled from their defaults, or null when the file has no servers. */
export type ParseResult = {
  title: string;
  serverUrl: string | null;
  operations: ParsedOperation[];
  skipped: SkippedOperation[];
  authHint: AuthHint | null;
};

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

/** The parts of a key: one, or the several a requirement of schemes at once needs. */
export const partsOf = (hint: AuthHint): AuthPart[] => hint.parts ?? [hint];

/** True when a parameter is at this part's place: same placement, and the same name (any case for a header). */
const atPart = (p: { name: string; in: string }, part: AuthPart): boolean =>
  p.in === part.in && (part.in === "header" ? p.name.toLowerCase() === part.name.toLowerCase() : p.name === part.name);

/** True when a declared parameter is where the gateway puts (a part of) the API's key: it is not a buyer input. */
export function isAuthParam(p: { name: string; in: string }, hint: AuthHint | null): boolean {
  return !!hint && partsOf(hint).some((part) => atPart(p, part));
}

function buildInputSchema(params: Param[], requestBody: unknown, hint: AuthHint | null): { schema: InputSchema } | { reason: string } {
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const p of params) {
    if (isAuthParam(p, hint)) continue;
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

type AuthNeed = { kind: "none" } | { kind: "key"; options: AuthHint[] } | { kind: "unsupported"; reason: string };

/** One security scheme as a key Hirakumi can supply, or the reason it can't (same name rules as the seller's key form). */
function schemeHint(scheme: unknown): AuthHint | string {
  if (!isRecord(scheme)) return "uses a security scheme the file doesn't define";
  if (scheme.type === "apiKey") {
    if (scheme.in === "cookie") return "needs a key in a cookie (not supported yet)";
    if ((scheme.in !== "header" && scheme.in !== "query") || typeof scheme.name !== "string") return "has an apiKey scheme without a header or query name";
    try {
      validateUpstreamAuth({ in: scheme.in, name: scheme.name, value: "x".repeat(16) });
    } catch (e) {
      if (e instanceof UpstreamAuthError) return `needs a key Hirakumi can't send: ${e.message}`;
      throw e;
    }
    return { in: scheme.in, name: scheme.name.trim() };
  }
  if (scheme.type === "http") {
    const name = typeof scheme.scheme === "string" ? scheme.scheme.toLowerCase() : "";
    if (name === "bearer") return { in: "header", name: "Authorization", prefix: "Bearer " };
    if (name === "basic") return "needs HTTP basic sign-in (not supported yet)";
    return `needs HTTP ${name || "unknown"} sign-in (not supported yet)`;
  }
  if (scheme.type === "oauth2") return "needs OAuth 2 sign-in (not supported yet)";
  if (scheme.type === "openIdConnect") return "needs OpenID Connect sign-in (not supported yet)";
  if (scheme.type === "mutualTLS") return "needs a client certificate (not supported yet)";
  return "uses a security scheme Hirakumi doesn't know (not supported yet)";
}

/**
 * Several schemes required at once, as one key in several parts, or why it can't be one: the parts must be distinct
 * and fit a preset of the seller's key form (two headers, or headers and query parameters, at most 4).
 */
function multiPartHint(parts: AuthPart[]): AuthHint | string {
  if (parts.length > MAX_UPSTREAM_PARTS) return `needs ${parts.length} keys at once, and Hirakumi sends at most ${MAX_UPSTREAM_PARTS}`;
  if (new Set(parts.map((p) => (p.in === "header" ? `h:${p.name.toLowerCase()}` : `q:${p.name}`))).size !== parts.length) {
    return "needs two keys in the same place at once (not supported yet)";
  }
  const headers = parts.filter((p) => p.in === "header").length;
  const fits = (headers === 2 && parts.length === 2) || (headers > 0 && headers < parts.length);
  if (!fits) return `needs ${parts.length} ${headers ? "header keys" : "query keys"} at once (not supported yet)`;
  return { ...parts[0]!, parts };
}

/** An operation's security: none (or optional), one key Hirakumi can add (any of `options`), or unsupported. */
function authNeed(op: Json, doc: Json, opts: ParseOptions): AuthNeed {
  const security = op.security ?? doc.security;
  if (!Array.isArray(security) || security.length === 0) return { kind: "none" };
  if (security.some((s) => isRecord(s) && Object.keys(s).length === 0)) return { kind: "none" };
  const components = isRecord(doc.components) ? doc.components : {};
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  const options: AuthHint[] = [];
  const reasons: string[] = [];
  for (const req of security) {
    if (!isRecord(req)) continue;
    const names = Object.keys(req);
    if (names.length > 1 && !opts.multiPartKeys) {
      reasons.push("needs two or more keys at once (not supported yet)");
      continue;
    }
    const hints = names.map((n) => schemeHint(schemes[n]));
    const bad = hints.find((h): h is string => typeof h === "string");
    if (bad) {
      reasons.push(bad);
      continue;
    }
    const h = hints.length === 1 ? (hints[0] as AuthPart) : multiPartHint(hints as AuthPart[]);
    if (typeof h === "string") reasons.push(h);
    else options.push(h);
  }
  if (options.length) return { kind: "key", options };
  return { kind: "unsupported", reason: reasons[0] ?? "needs authentication (not supported yet)" };
}

const samePart = (a: AuthPart, b: AuthPart) => atPart(a, b) && (a.prefix ?? "") === (b.prefix ?? "");
/** The same key: the same parts, in any order (a requirement's schemes have no order). */
const sameHint = (a: AuthHint, b: AuthHint) => {
  const pa = partsOf(a);
  const pb = partsOf(b);
  return pa.length === pb.length && pa.every((x) => pb.some((y) => samePart(x, y)));
};

/** The key most operations accept (the first seen wins a tie). */
function pickAuthHint(needs: AuthNeed[]): AuthHint | null {
  const votes: { hint: AuthHint; count: number }[] = [];
  for (const need of needs) {
    if (need.kind !== "key") continue;
    for (const option of uniqueValues(need.options)) {
      const v = votes.find((x) => sameHint(x.hint, option));
      if (v) v.count += 1;
      else votes.push({ hint: option, count: 1 });
    }
  }
  return votes.reduce<{ hint: AuthHint; count: number } | null>((best, v) => (!best || v.count > best.count ? v : best), null)?.hint ?? null;
}

/**
 * "the X-API-Key header", "a bearer token in the Authorization header", "the api_key query parameter"; for a key in
 * several parts, each part joined: "the X-App-Id header and the X-API-Key header".
 */
export function describeAuthHint(h: AuthHint): string {
  return partsOf(h).map(describePart).join(" and ");
}

function describePart(h: AuthPart): string {
  if (h.in === "query") return `the ${h.name} query parameter`;
  if (h.prefix?.trim().toLowerCase() === "bearer") return `a bearer token in the ${h.name} header`;
  return `the ${h.name} header`;
}

/**
 * The text says it is an OpenAPI or Swagger document (an object with an "openapi" or "swagger" version), valid or
 * not. A web page, plain JSON or an error body is not.
 */
export function isOpenApiDocument(text: unknown): boolean {
  if (typeof text !== "string") return false;
  try {
    const raw: unknown = YAML.parse(text);
    return isRecord(raw) && (typeof raw.openapi === "string" || typeof raw.swagger === "string");
  } catch {
    return false;
  }
}

/**
 * Parses an OpenAPI 3.x document (JSON or YAML text). Never fetches anything: external $refs are not resolved.
 * servers[0] (the API's base) is read with @hirakumi/core firstServerUrl.
 */
export async function parseOpenApi(text: string, opts: ParseOptions = {}): Promise<ParseResult> {
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
  const entries: { path: string; item: Json; method: HttpMethod; op: Json; need: AuthNeed }[] = [];
  for (const [path, item] of Object.entries(isRecord(doc.paths) ? doc.paths : {})) {
    if (!isRecord(item)) continue;
    for (const m of METHODS) {
      const op = item[m];
      if (isRecord(op)) entries.push({ path, item, method: m.toUpperCase() as HttpMethod, op, need: authNeed(op, doc, opts) });
    }
  }
  // The proof covers one folder; a path like /../other would make the upstream URL leave it.
  const safe = entries.filter((e) => !unsafePathReason(e.path));
  const authHint = pickAuthHint(safe.map((e) => e.need));
  for (const { path, item, method, op, need } of entries) {
    const unsafe = unsafePathReason(path);
    if (unsafe) {
      skipped.push({ method, path, reason: `${unsafe}, which could reach outside your API's folder` });
      continue;
    }
    if (need.kind === "unsupported") {
      skipped.push({ method, path, reason: need.reason });
      continue;
    }
    if (need.kind === "key" && !need.options.some((o) => authHint && sameHint(o, authHint))) {
      skipped.push({ method, path, reason: `needs a different key (${describeAuthHint(need.options[0])}) than your other endpoints, and Hirakumi keeps one key per API` });
      continue;
    }
    const params = mergeParams(item.parameters, op.parameters);
    const built = buildInputSchema(params, op.requestBody, authHint);
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
    const visible = params.filter((p) => !isAuthParam(p, authHint));
    operations.push({
      opId,
      method,
      path,
      inputSchema: built.schema,
      // A declared key parameter (with no security scheme) also means the gateway must add the key.
      needsKey: need.kind === "key" || visible.length !== params.length,
      llm: {
        opId,
        method,
        path,
        summary: clip(op.summary),
        description: clip(op.description),
        parameters: visible.map((p) => ({ name: p.name, in: p.in, description: clip(p.description) })),
      },
    });
  }
  const info = isRecord(doc.info) ? doc.info : {};
  const used = operations.some((o) => o.needsKey) ? authHint : null;
  return { title: clip(info.title) ?? "Untitled API", serverUrl: firstServerUrl(doc.servers), operations, skipped, authHint: used };
}
