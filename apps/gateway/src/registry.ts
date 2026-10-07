import Ajv2020 from "ajv/dist/2020.js";
import {
  compileRule, formatSchemaErrors, isUpstreamBag, jcs, openUpstreamBag, openUpstreamSecret, UpstreamAddressChangedError, validateUpstreamAuth,
  validateUpstreamBag, type CompiledRule, type UpstreamAuth, type UpstreamCredential,
} from "@hirakumi/core";
import { loadApiBundle, type ApiRow, type OperationRow, type PackRow, type RuleRow, type Sql } from "@hirakumi/db";
import type { HealthTracker } from "./health";

export type InputCheck = { ok: true; value: Record<string, unknown> } | { ok: false; reasons: string[] };
export type LoadedOp = { row: OperationRow; ruleRow: RuleRow | null; rule: CompiledRule | null; validateInput(input: unknown): InputCheck };
/**
 * How the gateway reaches the API: its row, plus the opened key when it needs one. credentialError is set when a
 * key is stored but can't be opened; every upstream call is then blocked rather than sent without it. A key of
 * several parts (an hks3 bag) opens to `auth` instead, with credential null: read either through resolveAuth.
 */
export type UpstreamAccess = { credential: UpstreamCredential | null; credentialError: string | null; auth?: UpstreamAuth };

/** credentialError when the gateway has no usable private key. The monitor reads it as an operator problem. */
export const KEYS_UNAVAILABLE = "this API needs a key, and the gateway can't read keys right now";
export type LoadedApi = { api: ApiRow & UpstreamAccess; ops: Map<string, LoadedOp>; packs: PackRow[] };

/**
 * Opens an API's stored key with the gateway's private key. Never throws; the reason is in credentialError, which
 * buyers can see, so it never names the key or the gateway's settings. The placement and name are stored in the
 * clear, so they are checked again here like the web app checks them (no reserved header, no line breaks).
 * The key opens only for the placement, name, origin and path prefix it was sealed with: a key saved before the
 * API's address changed blocks every call until the seller saves it again. A bag (hks3) opens the same way for its
 * parts' placements and names in order, and its parts and leak list are checked again (validateUpstreamBag).
 */
export function openCredential(api: Pick<ApiRow, "id" | "upstream_auth" | "origin" | "path_prefix">, privateKey: string | null): UpstreamAccess {
  const stored = api.upstream_auth;
  if (!stored) return { credential: null, credentialError: null };
  if (!privateKey) return { credential: null, credentialError: KEYS_UNAVAILABLE };
  try {
    if (isUpstreamBag(stored)) {
      const parts = stored.parts.map((p) => ({ in: p.in, name: p.name }));
      const bag = openUpstreamBag(privateKey, { apiId: api.id, parts, origin: api.origin, pathPrefix: api.path_prefix }, stored.sealed);
      return { credential: null, credentialError: null, auth: validateUpstreamBag(parts, bag) };
    }
    const value = openUpstreamSecret(privateKey, { apiId: api.id, in: stored.in, name: stored.name, origin: api.origin, pathPrefix: api.path_prefix }, stored.sealed);
    return { credential: validateUpstreamAuth({ in: stored.in, name: stored.name, value }), credentialError: null };
  } catch (e) {
    if (e instanceof UpstreamAddressChangedError) return { credential: null, credentialError: ADDRESS_CHANGED };
    return { credential: null, credentialError: "this API's key could not be read. The seller should enter it again" };
  }
}

export const ADDRESS_CHANGED = "The API's address changed since the key was saved. Save the key again.";

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
  constructor(private readonly sql: Sql, private readonly health: HealthTracker, private readonly upstreamAuthKey: string | null = null) {}

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
    const access = openCredential(b.api, this.upstreamAuthKey);
    if (access.credentialError) {
      console.warn(`[registry] ${b.api.id}: ${access.credentialError}${this.upstreamAuthKey ? "" : " (UPSTREAM_AUTH_PRIVATE_KEY is not set)"}`);
    }
    return { api: { ...b.api, ...access }, ops, packs: b.packs };
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
