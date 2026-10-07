// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { apiStatus, statusLight } from "@/lib/status-labels";
import { StatusLight } from "./status-light";

describe("statusLight", () => {
  it("derives colour, label and pulse from the API's status", () => {
    expect(statusLight(apiStatus("live", "healthy", false).tone, "live")).toEqual({ color: "mint", label: "Running", pulse: true });
    expect(statusLight(apiStatus("live", "down", false).tone, "live")).toEqual({ color: "coral", label: "Down", pulse: false });
    expect(statusLight(apiStatus("parsed", "down", true).tone, "parsed")).toEqual({ color: "pencil", label: "Stopped", pulse: false });
    expect(statusLight(apiStatus("retired", "down", false).tone, "retired")).toEqual({ color: "pencil", label: "Retired", pulse: false });
    expect(statusLight(apiStatus("registering", "down", false).tone, "registering"))
      .toEqual({ color: "sky", label: "Setting up: Registering on the Masumi network", pulse: false });
  });

  it("never uses em or en dashes in a label", () => {
    const states = ["intake", "parsed", "described", "endpoints_confirmed", "ownership_verified", "rule_built", "priced", "registering"] as const;
    for (const s of states) expect(statusLight("progress", s).label).not.toMatch(/[–—]/);
  });
});

describe("StatusLight", () => {
  it("is an image named by its label, reachable by keyboard, with the label shown beside it", async () => {
    render(<StatusLight tone="live" state="live" />);
    const light = screen.getByRole("img", { name: "Running" });
    await userEvent.setup().tab();
    expect(light).toHaveFocus();
    const tip = screen.getByText("Running");
    expect(tip).toHaveAttribute("aria-hidden");
    expect(tip.className).toMatch(/group-focus-visible:visible/);
    expect(tip.className).toMatch(/group-hover:visible/);
  });

  it("pulses only while running", () => {
    const { container, rerender } = render(<StatusLight tone="live" state="live" />);
    expect(container.querySelector(".animate-status-pulse")).not.toBeNull();
    rerender(<StatusLight tone="down" state="live" />);
    expect(container.querySelector(".animate-status-pulse")).toBeNull();
    expect(container.querySelector(".bg-coral")).not.toBeNull();
  });
});
