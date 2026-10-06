import { describe, expect, it } from "vitest";
import { recordsKeptReason, type DeleteFacts } from "./api-delete";
import { API_STATES } from "./types";

const clean: DeleteFacts = { state: "priced", agentIdentifier: null, registerStarted: false, sold: false };
const REGISTRY = "It reached the Masumi registry, so we keep its records.";

describe("recordsKeptReason", () => {
  it("erases every state before registering when nothing reached Masumi and nothing sold", () => {
    const before = API_STATES.slice(0, API_STATES.indexOf("registering"));
    for (const state of before) expect(recordsKeptReason({ ...clean, state })).toBeNull();
  });

  it("keeps the records of registering, live and retired APIs", () => {
    for (const state of ["registering", "live", "retired"] as const) expect(recordsKeptReason({ ...clean, state })).toBe(REGISTRY);
  });

  it("keeps the records of an API with an agent identifier or a started register step, whatever its state", () => {
    expect(recordsKeptReason({ ...clean, agentIdentifier: "agent_1" })).toBe(REGISTRY);
    expect(recordsKeptReason({ ...clean, registerStarted: true })).toBe(REGISTRY);
  });

  it("keeps the receipts of an API buyers paid for", () => {
    expect(recordsKeptReason({ ...clean, sold: true })).toBe("Buyers paid for it, so we keep their receipts.");
  });
});
