// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildTimeline } from "@/lib/timeline";
import type { OnboardStep } from "@/lib/types";
import { StepList } from "./step-list";

const at = new Date("2026-10-06T10:00:00Z");
const row = (step: string, status: OnboardStep["status"], output: unknown = null): OnboardStep => ({ step, status, output, updatedAt: at });

const LABELS = ["Read your file", "Describe endpoints", "Choose endpoints", "Prove ownership", "Test calls", "Write the promise", "Register on Masumi"];

describe("buildTimeline", () => {
  it("is always the same seven human steps, in order", () => {
    for (const state of ["intake", "described", "ownership_verified", "registering", "live"] as const) {
      expect(buildTimeline(state, []).items.map((i) => i.label)).toEqual(LABELS);
    }
  });

  it("never shows raw step names or stray rows", () => {
    const t = buildTimeline("ownership_verified", [
      row("parse", "done"), row("describe", "done"), row("seller_samples", "done", { getPrice: [] }), row("qa", "running"),
    ]);
    expect(t.items).toHaveLength(7);
    expect(t.items.map((i) => i.label).join(" ")).not.toMatch(/qa|parse|seller_samples/i);
  });

  it("counts completed steps out of the total", () => {
    const t = buildTimeline("ownership_verified", [row("parse", "done"), row("describe", "done"), row("qa", "running")]);
    expect(t.items.map((i) => i.status)).toEqual(["done", "done", "done", "done", "running", "pending", "pending"]);
    expect([t.done, t.total, t.pct]).toEqual([4, 7, 57]);
    expect(t.current?.label).toBe("Test calls");
  });

  it("waits for the seller on the seller's own steps", () => {
    expect(buildTimeline("described", []).current).toMatchObject({ label: "Choose endpoints", status: "waiting_seller" });
    expect(buildTimeline("endpoints_confirmed", []).current).toMatchObject({ label: "Prove ownership", status: "waiting_seller" });
    expect(buildTimeline("priced", []).current).toMatchObject({ label: "Register on Masumi", status: "waiting_seller" });
  });

  it("carries live test-call progress and moves on to writing the promise once the calls are done", () => {
    const running = buildTimeline("ownership_verified", [row("qa", "running", { progress: { done: 4, total: 6, startedAt: "2026-10-06T09:59:00.000Z" } })]);
    expect(running.items[4]).toMatchObject({ status: "running", progress: { done: 4, total: 6 }, since: "2026-10-06T09:59:00.000Z" });
    const writing = buildTimeline("ownership_verified", [row("qa", "running", { progress: { done: 6, total: 6 } })]);
    expect(writing.items.slice(4, 6).map((i) => i.status)).toEqual(["done", "running"]);
  });

  it("marks the failing step and everything done once live", () => {
    expect(buildTimeline("intake", [row("parse", "failed", { error: "404" })]).items[0].status).toBe("failed");
    const live = buildTimeline("live", []);
    expect([live.done, live.pct, live.current]).toEqual([7, 100, null]);
  });
});

describe("StepList", () => {
  it("shows steps done out of total as a progress bar", () => {
    render(<StepList timeline={buildTimeline("ownership_verified", [row("qa", "running", { progress: { done: 2, total: 6 } })])} />);
    expect(screen.getByText("4 of 7 steps done")).toBeInTheDocument();
    expect(screen.getByText("57%")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Listing progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "4");
    expect(bar).toHaveAttribute("aria-valuemax", "7");
    expect(bar).toHaveAttribute("aria-valuetext", "4 of 7 done, now test calls");
    expect(bar.querySelectorAll("[data-status=done]")).toHaveLength(4);
  });

  it("lists every step by its human label with live sub-progress on the running one", async () => {
    render(<StepList timeline={buildTimeline("ownership_verified", [row("qa", "running", { progress: { done: 2, total: 6 } })])} />);
    for (const label of LABELS) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getAllByText("Done")).toHaveLength(4);
    const running = screen.getByText("Test calls").closest("li")!;
    expect(running).toHaveTextContent("2 of 6 calls");
    expect(await screen.findByText(/\d+m \d{2}s|\d+s/)).toBeInTheDocument();
  });
});
