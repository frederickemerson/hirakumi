import Ajv2020 from "ajv/dist/2020.js";
import { compileRule, formatSchemaErrors, jcs, type CompiledRule } from "@hirakumi/core";
import { loadApiBundle, type ApiRow, type OperationRow, type PackRow, type RuleRow, type Sql } from "@hirakumi/db";
import type { HealthTracker } from "./health";

export type InputCheck = { ok: true; value: Record<string, unknown> } | { ok: false; reasons: string[] };
export type LoadedOp = { row: OperationRow; ruleRow: RuleRow | null; rule: CompiledRule | null; validateInput(input: unknown): InputCheck };
export type LoadedApi = { api: ApiRow; ops: Map<string, LoadedOp>; packs: PackRow[] };

const inputAjv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true });
const validators = new Map<string, (input: unknown) => InputCheck>();

/** Compiled once per distinct schema (keyed by JCS). Validates a clone, so coercion never mutates the caller's object. */
export function compileInputValidator(schema: Record<string, unknown>): (input: unknown) => InputCheck {
  const key = jcs(schema);
  const hit = validators.get(key);
  if (hit) return hit;
  const validate = inputAjv.compile(schema);
  const fn = (input: unknown): InputCheck => {
    const value = structuredClone(input ?? {}) as Record<string, unknown>;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reasons: ["input must be an object"] };
    return validate(value) ? { ok: true, value } : { ok: false, reasons: formatSchemaErrors(validate.errors) };
  };
  validators.set(key, fn);
  return fn;
}

export const REGISTRY_TTL_MS = 60_000;

export class ApiRegistry {
  private readonly cache = new Map<string, { at: number; value: Promise<LoadedApi | null> }>();
  constructor(private readonly sql: Sql, private readonly health: HealthTracker) {}

  get(apiId: string, opts: { fresh?: boolean } = {}): Promise<LoadedApi | null> {
    const hit = this.cache.get(apiId);
    if (hit && !opts.fresh && Date.now() - hit.at < REGISTRY_TTL_MS) return hit.value;
    const value = this.load(apiId);
    this.cache.set(apiId, { at: Date.now(), value });
    value.then(
      (v) => { if (!v) this.cache.delete(apiId); },
      () => { this.cache.delete(apiId); },
    );
    return value;
  }

  /** /internal/apis/:apiId/reload — forget cached rules, prices and in-memory health. */
  invalidate(apiId: string): void {
    this.cache.delete(apiId);
    this.health.reset(apiId);
  }

  private async load(apiId: string): Promise<LoadedApi | null> {
    const b = await loadApiBundle(this.sql, apiId);
    if (!b) return null;
    this.health.seed(b.api.id, b.api.health, b.api.health_checked_at);
    const rulesByOp = new Map(b.rules.map((r) => [r.operation_id, r]));
    const ops = new Map<string, LoadedOp>();
    for (const row of b.operations) {
      const ruleRow = rulesByOp.get(row.id) ?? null;
      let rule: CompiledRule | null = ruleRow ? compileRule(ruleRow.definition) : null;
      if (rule && ruleRow && rule.hash !== ruleRow.hash) {
        console.error(`[registry] rule ${ruleRow.id} hash ${ruleRow.hash} does not match its definition (${rule.hash}); not serving it`);
        rule = null;
      }
      ops.set(row.op_id, { row, ruleRow: rule ? ruleRow : null, rule, validateInput: compileInputValidator(row.input_schema) });
    }
    return { api: b.api, ops, packs: b.packs };
  }
}

/** apis.escrow_op_id names operations.id; an OpenAPI op_id is accepted too. */
export function escrowOperation(l: LoadedApi): LoadedOp | undefined {
  const id = l.api.escrow_op_id;
  if (!id) return undefined;
  for (const op of l.ops.values()) if (op.row.id === id) return op;
  return l.ops.get(id);
}

/** The promise a pack advertises: the escrow operation's rule, else the first enabled operation with one. */
export function primaryRule(l: LoadedApi): RuleRow | null {
  const escrow = escrowOperation(l);
  if (escrow?.ruleRow) return escrow.ruleRow;
  for (const op of l.ops.values()) if (op.row.enabled && op.ruleRow) return op.ruleRow;
  return null;
}
