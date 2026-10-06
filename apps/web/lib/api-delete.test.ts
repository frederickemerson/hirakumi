import { describe, expect, it } from "vitest";
import { deleteBlocker, type DeleteFacts } from "./api-delete";
import { API_STATES } from "./types";

const clean: DeleteFacts = { state: "priced", agentIdentifier: null, registerStarted: false, sold: false };

describe("deleteBlocker", () => {
  it("allows every state before registering when nothing reached Masumi and nothing sold", () => {
    const before = API_STATES.slice(0, API_STATES.indexOf("registering"));
    for (const state of before) expect(deleteBlocker({ ...clean, state })).toBeNull();
  });

  it("sends a live API to Retire", () => {
    expect(deleteBlocker({ ...clean, state: "live" })).toBe("This API is on the Masumi registry. Retire it instead.");
  });

  it("refuses registering and retired APIs", () => {
    for (const state of ["registering", "retired"] as const) {
      expect(deleteBlocker({ ...clean, state })).toBe("This API reached the Masumi registry, so its records stay.");
    }
  });

  it("refuses an API with an agent identifier or a started register step, whatever its state", () => {
    expect(deleteBlocker({ ...clean, agentIdentifier: "agent_1" })).toMatch(/reached the Masumi registry/);
    expect(deleteBlocker({ ...clean, registerStarted: true })).toMatch(/reached the Masumi registry/);
  });

  it("refuses an API buyers paid for", () => {
    expect(deleteBlocker({ ...clean, sold: true })).toBe("Buyers paid for this API, so its records stay.");
  });
});
