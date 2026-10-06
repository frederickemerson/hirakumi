export type EndpointSelection = {
  enabledIds: string[];
  confirmedNoSideEffectIds: string[];
  escrowOperationId: string | null;
};

type OpLike = { id: string; method: string; path: string; sideEffectsLikely: boolean };

export function needsNoSideEffectConfirmation(op: Pick<OpLike, "method" | "sideEffectsLikely">): boolean {
  return op.method.toUpperCase() !== "GET" || op.sideEffectsLikely;
}

export function validateEndpointSelection(ops: OpLike[], s: EndpointSelection): string | null {
  if (s.enabledIds.length === 0) return "Choose at least one endpoint to sell.";
  const byId = new Map(ops.map((o) => [o.id, o]));
  for (const id of s.enabledIds) {
    const op = byId.get(id);
    if (!op) return "One of the chosen endpoints no longer exists. Reload the page.";
    if (needsNoSideEffectConfirmation(op) && !s.confirmedNoSideEffectIds.includes(id)) {
      return `Confirm that ${op.method.toUpperCase()} ${op.path} changes nothing on your server, or don't sell it.`;
    }
  }
  if (!s.escrowOperationId) return "Choose which endpoint runs for per-job hires.";
  if (!s.enabledIds.includes(s.escrowOperationId)) return "The per-job endpoint must be one of the endpoints you sell.";
  return null;
}

function stringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

export function parseSelection(body: Record<string, unknown>): EndpointSelection | null {
  const enabledIds = stringArray(body.enabledIds);
  const confirmedNoSideEffectIds = stringArray(body.confirmedNoSideEffectIds);
  const escrow = body.escrowOperationId;
  if (!enabledIds || !confirmedNoSideEffectIds) return null;
  if (escrow !== null && typeof escrow !== "string") return null;
  return { enabledIds, confirmedNoSideEffectIds, escrowOperationId: escrow };
}
