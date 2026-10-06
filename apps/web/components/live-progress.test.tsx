// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { progressFor } from "@/lib/progress";
import { buildTimeline } from "@/lib/timeline";
import type { ApiState, OnboardStep } from "@/lib/types";
import { jsonResponse } from "@/test/http";
import { LiveProgress, nextDelay, POLL_MAX_MS, POLL_MIN_MS } from "./live-progress";

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), pathname: "/apis/api_1/review" }));
vi.mock("next/navigation", () => ({ useRouter: () => nav, usePathname: () => nav.pathname }));

const at = new Date("2026-10-06T10:00:00Z");
const progress = (state: ApiState, steps: OnboardStep[] = []) => progressFor({ id: "api_1", state }, buildTimeline(state, steps), null);
const qa = (done: number): OnboardStep => ({ step: "qa", status: "running", output: { progress: { done, total: 6 } }, updatedAt: at });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  nav.replace.mockReset();
  nav.refresh.mockReset();
});

describe("nextDelay", () => {
  it("polls every second while things change and backs off to five seconds", () => {
    expect(nextDelay(POLL_MIN_MS, false)).toBe(1500);
    expect(nextDelay(4000, false)).toBe(POLL_MAX_MS);
    expect(nextDelay(POLL_MAX_MS, true)).toBe(POLL_MIN_MS);
  });
});

describe("LiveProgress", () => {
  it("updates the timeline from the progress endpoint without refreshing the page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(progress("ownership_verified", [qa(4)])));
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveProgress apiId="api_1" initial={progress("ownership_verified", [qa(1)])} />);
    expect(screen.getByText("1 of 6 calls")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(POLL_MIN_MS));
    expect(fetchMock).toHaveBeenCalledWith("/api/apis/api_1/progress", expect.objectContaining({ cache: "no-store" }));
    expect(screen.getByText("4 of 6 calls")).toBeInTheDocument();
    expect(nav.refresh).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("moves to the next step's page when the state changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(progress("endpoints_confirmed"))));
    nav.pathname = "/apis/api_1/endpoints";
    render(<LiveProgress apiId="api_1" initial={progress("parsed")} />);
    await act(() => vi.advanceTimersByTimeAsync(POLL_MIN_MS));
    expect(nav.replace).toHaveBeenCalledWith("/apis/api_1/ownership");
    nav.pathname = "/apis/api_1/review";
  });

  it("refreshes in place when the state changes but the page stays the same", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(progress("rule_built"))));
    render(<LiveProgress apiId="api_1" initial={progress("ownership_verified", [qa(6)])} />);
    await act(() => vi.advanceTimersByTimeAsync(POLL_MIN_MS));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("pauses while the tab is hidden", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(progress("ownership_verified", [qa(1)])));
    vi.stubGlobal("fetch", fetchMock);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    render(<LiveProgress apiId="api_1" initial={progress("ownership_verified", [qa(1)])} />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMock).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
  });

  it("does not poll once the API is live", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveProgress apiId="api_1" initial={progress("live")} />);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
