import { describe, expect, it } from "vitest";
import { GUIDE, guideMessages, guideStepFor, type GuideStepKey } from "./guide";
import { progressFor } from "./progress";
import { buildTimeline } from "./timeline";
import { API_STATES, type ApiState, type OnboardStep } from "./types";

const at = new Date("2026-10-06T10:00:00Z");
const progress = (state: ApiState, steps: OnboardStep[] = [], failure: string | null = null) =>
  progressFor({ id: "api_1", state }, buildTimeline(state, steps), failure);
const qa = (done: number, total = 6): OnboardStep => ({ step: "qa", status: "running", output: { progress: { done, total } }, updatedAt: at });

describe("guide content", () => {
  const keys = Object.keys(GUIDE) as GuideStepKey[];

  it("says something for every step: what is happening, why it is safe, what comes next", () => {
    for (const key of keys) {
      const step = GUIDE[key];
      expect(step.title, key).not.toBe("");
      expect(step.now, key).not.toBe("");
      expect(step.safe, key).not.toBe("");
      expect(step.next, key).not.toBe("");
      expect(guideMessages(step).length, key).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses plain punctuation: no em or en dashes anywhere", () => {
    const all = JSON.stringify(GUIDE);
    expect(all).not.toMatch(/[–—]/);
  });

  it("answers the seller's real questions on the steps where they come up", () => {
    const questions = (key: GuideStepKey) => GUIDE[key].faqs.map((f) => f.q);
    expect(questions("ownership")).toContain("Why do you need my wallet?");
    expect(questions("price")).toContain("Can I change the price later?");
    expect(questions("price")).toContain("What is a promise?");
    expect(questions("live")).toContain("What if my API breaks?");
    expect(GUIDE.price.faqs.find((f) => f.q === "Can I change the price later?")!.a).toMatch(/Publishing locks it/);
    expect(GUIDE.live.faqs.find((f) => f.q === "What if my API breaks?")!.a).toMatch(/no credits are used/);
  });

  it("only gives timings the app can back up", () => {
    expect(GUIDE.test.time).toBe("Usually a few seconds.");
    expect(GUIDE.register.time).toBe("Usually about a minute.");
    expect(GUIDE.ownership.safe).toBe("Signing costs nothing and moves no funds.");
    expect(GUIDE.test.safe).toMatch(/Nothing is charged while I test/);
  });
});

describe("guideStepFor", () => {
  it("starts at paste before an API exists", () => {
    expect(guideStepFor(null)).toBe("paste");
  });

  it("follows the listing timeline through every state", () => {
    const expected: Record<ApiState, GuideStepKey> = {
      intake: "read",
      parsed: "describe",
      described: "choose",
      endpoints_confirmed: "ownership",
      ownership_verified: "test",
      rule_built: "price",
      priced: "publish",
      registering: "register",
      live: "live",
      retired: "retired",
    };
    for (const state of API_STATES) expect(guideStepFor(progress(state)), state).toBe(expected[state]);
  });

  it("moves from test calls to the promise once every call is done", () => {
    expect(guideStepFor(progress("ownership_verified", [qa(3)]))).toBe("test");
    expect(guideStepFor(progress("ownership_verified", [qa(6)]))).toBe("promise");
  });

  it("says when a step failed", () => {
    expect(guideStepFor(progress("intake", [], "We couldn't read that file."))).toBe("failed");
    const failedQa: OnboardStep = { step: "qa", status: "failed", output: { error: "502" }, updatedAt: at };
    expect(guideStepFor(progress("ownership_verified", [failedQa]))).toBe("failed");
  });
});
