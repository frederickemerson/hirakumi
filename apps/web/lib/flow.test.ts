import { describe, expect, it } from "vitest";
import { firstFailedStep, isStale, safeNextPath, stepForState } from "./flow";

describe("stepForState", () => {
  it("sends each state to the screen that can move it forward", () => {
    expect(stepForState("intake")).toBe("endpoints");
    expect(stepForState("described")).toBe("endpoints");
    expect(stepForState("endpoints_confirmed")).toBe("ownership");
    expect(stepForState("ownership_verified")).toBe("review");
    expect(stepForState("priced")).toBe("review");
    expect(stepForState("registering")).toBe("overview");
    expect(stepForState("live")).toBe("overview");
    expect(stepForState("retired")).toBe("overview");
  });
});

describe("safeNextPath", () => {
  it("only allows same-site paths", () => {
    expect(safeNextPath("/apis/api_1")).toBe("/apis/api_1");
    expect(safeNextPath("https://evil.example")).toBe("/apis");
    expect(safeNextPath("//evil.example")).toBe("/apis");
    expect(safeNextPath("/\\evil.example")).toBe("/apis");
    expect(safeNextPath(undefined)).toBe("/apis");
  });
});

describe("isStale", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  it("is stale when never checked or older than 10 minutes", () => {
    expect(isStale(null, now)).toBe(true);
    expect(isStale(new Date("2026-10-06T11:49:00Z"), now)).toBe(true);
    expect(isStale(new Date("2026-10-06T11:55:00Z"), now)).toBe(false);
  });
});

describe("firstFailedStep", () => {
  it("returns the coworker's plain-English error for a failed step", () => {
    expect(
      firstFailedStep([
        { status: "done", output: null },
        { status: "failed", output: { error: "This looks like Swagger 2.0. Hirakumi needs OpenAPI 3.x." } },
      ]),
    ).toBe("This looks like Swagger 2.0. Hirakumi needs OpenAPI 3.x.");
  });
  it("falls back to a generic sentence when the step has no message", () => {
    expect(firstFailedStep([{ status: "failed", output: null }])).toMatch(/Something went wrong while preparing your listing/);
  });
  it("returns null when nothing failed", () => {
    expect(firstFailedStep([{ status: "running", output: null }])).toBeNull();
  });
});
