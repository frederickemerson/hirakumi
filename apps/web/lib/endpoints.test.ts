import { describe, expect, it } from "vitest";
import { needsNoSideEffectConfirmation, parseSelection, validateEndpointSelection } from "./endpoints";

const ops = [
  { id: "op_get", method: "GET", path: "/price", sideEffectsLikely: false },
  { id: "op_post", method: "POST", path: "/admin/refresh", sideEffectsLikely: true },
  { id: "op_risky_get", method: "GET", path: "/reset", sideEffectsLikely: true },
];

describe("endpoint selection", () => {
  it("needs a no-side-effects tick for non-GET or flagged operations", () => {
    expect(needsNoSideEffectConfirmation(ops[0])).toBe(false);
    expect(needsNoSideEffectConfirmation(ops[1])).toBe(true);
    expect(needsNoSideEffectConfirmation(ops[2])).toBe(true);
  });

  it("accepts a GET with an escrow choice", () => {
    expect(validateEndpointSelection(ops, { enabledIds: ["op_get"], confirmedNoSideEffectIds: [], escrowOperationId: "op_get" })).toBeNull();
  });

  it("requires at least one endpoint", () => {
    expect(validateEndpointSelection(ops, { enabledIds: [], confirmedNoSideEffectIds: [], escrowOperationId: null }))
      .toBe("Choose at least one endpoint to sell.");
  });

  it("requires the tick for a POST endpoint", () => {
    expect(validateEndpointSelection(ops, { enabledIds: ["op_post"], confirmedNoSideEffectIds: [], escrowOperationId: "op_post" }))
      .toBe("Confirm that POST /admin/refresh changes nothing on your server, or don't sell it.");
  });

  it("requires the escrow endpoint to be one of the sold endpoints", () => {
    expect(validateEndpointSelection(ops, { enabledIds: ["op_get"], confirmedNoSideEffectIds: [], escrowOperationId: null }))
      .toBe("Choose which endpoint runs for per-job hires.");
    expect(validateEndpointSelection(ops, { enabledIds: ["op_get"], confirmedNoSideEffectIds: ["op_post"], escrowOperationId: "op_post" }))
      .toBe("The per-job endpoint must be one of the endpoints you sell.");
  });

  it("rejects unknown operation ids", () => {
    expect(validateEndpointSelection(ops, { enabledIds: ["op_gone"], confirmedNoSideEffectIds: [], escrowOperationId: "op_gone" }))
      .toBe("One of the chosen endpoints no longer exists. Reload the page.");
  });

  it("parses a request body defensively", () => {
    expect(parseSelection({ enabledIds: ["a"], confirmedNoSideEffectIds: [], escrowOperationId: "a" }))
      .toEqual({ enabledIds: ["a"], confirmedNoSideEffectIds: [], escrowOperationId: "a" });
    expect(parseSelection({ enabledIds: "a" })).toBeNull();
    expect(parseSelection({ enabledIds: [1], confirmedNoSideEffectIds: [], escrowOperationId: null })).toBeNull();
  });
});
