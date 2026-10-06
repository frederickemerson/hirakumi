import { describe, expect, it } from "vitest";
import { selectMode } from "../src/mode.js";

const me = { id: "cow_1", name: "Hirakumi", isWhitelisted: true, capabilities: ["tasks"], archivedAt: null };

describe("selectMode (hour-2 gate)", () => {
  it("uses Sokosumi for an active coworker with the tasks capability", () => {
    expect(selectMode(me)).toEqual({ kind: "sokosumi" });
    expect(selectMode(null)).toMatchObject({ kind: "dashboard" });
    // Whitelisting only controls marketplace listing: a non-whitelisted coworker still receives task events
    // and can comment on its personal-workspace tasks (verified live on preprod, 6 Oct 2026).
    expect(selectMode({ ...me, isWhitelisted: false })).toEqual({ kind: "sokosumi" });
    expect(selectMode({ ...me, capabilities: ["chat"] })).toMatchObject({ kind: "dashboard" });
    expect(selectMode({ ...me, archivedAt: "2026-10-06T00:00:00Z" })).toMatchObject({ kind: "dashboard" });
  });
});
