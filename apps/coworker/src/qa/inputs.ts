import { PermanentError } from "../errors.js";
import { uniqueValues, type InputSchema } from "../openapi/parse.js";

const MAX_INPUTS = 10;
export const INVALID_STRING = "__hk_invalid__";

type Prop = Record<string, unknown>;

function candidates(p: Prop): unknown[] {
  const out: unknown[] = [];
  if (Array.isArray(p.examples)) out.push(...p.examples);
  if (p.default !== undefined) out.push(p.default);
  if (Array.isArray(p.enum)) out.push(...p.enum);
  return uniqueValues(out);
}

/**
 * Good test inputs: the seller's samples, then one input built from the first example of every
 * property, then one variant per extra example/enum value. Throws when a required value is unknown.
 */
export function buildGoodInputs(schema: InputSchema, sellerSamples: Record<string, unknown>[], opId: string): Record<string, unknown>[] {
  const names = Object.keys(schema.properties);
  const values = new Map(names.map((n) => [n, candidates(schema.properties[n])]));
  const out: Record<string, unknown>[] = [...sellerSamples];
  const missing = schema.required.filter((n) => (values.get(n) ?? []).length === 0);
  if (missing.length === 0) {
    const base: Record<string, unknown> = {};
    for (const n of names) {
      const v = values.get(n) ?? [];
      if (v.length) base[n] = v[0];
    }
    out.push(base);
    for (const n of names) for (const v of (values.get(n) ?? []).slice(1)) out.push({ ...base, [n]: v });
  } else if (sellerSamples.length === 0) {
    throw new PermanentError(
      `To test ${opId} we need an example value for ${missing.map((m) => `"${m}"`).join(", ")}. Add an "example" to that parameter in your OpenAPI file, or give us a sample input, and try again.`,
    );
  }
  return uniqueValues(out).slice(0, MAX_INPUTS);
}

function canHoldInvalidString(p: Prop): boolean {
  if (p.type !== "string") return false;
  if (p.enum !== undefined || p.const !== undefined || p.format !== undefined || p.pattern !== undefined) return false;
  if (typeof p.maxLength === "number" && p.maxLength < INVALID_STRING.length) return false;
  if (typeof p.minLength === "number" && p.minLength > INVALID_STRING.length) return false;
  return true;
}

/** A schema-valid input that names nothing real, so a correct API answers with an error. null if impossible. */
export function buildBadInput(schema: InputSchema, good: Record<string, unknown>): Record<string, unknown> | null {
  const bad = { ...good };
  let changed = false;
  for (const [name, p] of Object.entries(schema.properties)) {
    if (name === "body" || !(name in good) || !canHoldInvalidString(p)) continue;
    bad[name] = INVALID_STRING;
    changed = true;
  }
  return changed ? bad : null;
}
