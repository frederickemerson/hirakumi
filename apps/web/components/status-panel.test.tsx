// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PublicStatus } from "@/lib/repo/status";
import { StatusPanel } from "./status-panel";

const hours = Array.from({ length: 24 }, (_, i) => ({
  start: new Date(Date.UTC(2026, 9, 7, i)), probes: i === 20 ? 2 : i > 20 ? 6 : 0, passed: i > 20 ? 6 : 0,
  state: (i === 20 ? "down" : i > 20 ? "up" : "no_data") as PublicStatus["hours"][number]["state"],
}));

describe("StatusPanel", () => {
  it("shows uptime, pass rate and one labelled bar per hour", () => {
    render(<StatusPanel status={{ uptimePct: 80, hours, paidCalls: 3, passRatePct: 67, p50LatencyMs: 140 }}
      incidents={[{ downAt: new Date("2026-10-07T20:05:00Z"), upAt: new Date("2026-10-07T20:40:00Z"), reasons: [{ op: "getPrice", reason: "/usd is missing", since: "x" }], creditsUsed: 0, callsNotPassed: 4 }]} />);
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem", { name: /UTC/ })).toHaveLength(24);
    expect(screen.getByRole("listitem", { name: /20:00 UTC: Down/ })).toBeInTheDocument();
    expect(screen.getByText("getPrice: /usd is missing")).toBeInTheDocument();
    expect(screen.getByText(/0 credits used/)).toBeInTheDocument();
  });
  it("says so plainly when there is no data yet", () => {
    render(<StatusPanel status={{ uptimePct: null, hours: hours.map((h) => ({ ...h, probes: 0, passed: 0, state: "no_data" as const })), paidCalls: 0, passRatePct: null, p50LatencyMs: null }} incidents={[]} />);
    expect(screen.getAllByText("No data yet").length).toBeGreaterThan(0);
    expect(screen.getByText("No incidents in the last checks.")).toBeInTheDocument();
  });
});
