import { describe, expect, it } from "vitest";
import { selectMode } from "../src/mode.js";

const me = { id: "cow_1", name: "Hirakumi", isWhitelisted: true, capabilities: ["tasks"], archivedAt: null };

describe("selectMode (hour-2 gate)", () => {
  it("uses Sokosumi only for an active, whitelisted coworker with the tasks capability", () => {
    expect(selectMode(me)).toEqual({ kind: "sokosumi" });
    expect(selectMode(null)).toMatchObject({ kind: "dashboard" });
    expect(selectMode({ ...me, isWhitelisted: false })).toEqual({ kind: "dashboard", reason: "coworker cow_1 is not whitelisted yet" });
    expect(selectMode({ ...me, capabilities: ["chat"] })).toMatchObject({ kind: "dashboard" });
    expect(selectMode({ ...me, archivedAt: "2026-10-06T00:00:00Z" })).toMatchObject({ kind: "dashboard" });
  });
});
