// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthBadge } from "./health-badge";

const now = new Date("2026-10-06T12:00:00Z");

describe("HealthBadge", () => {
  it("says Live for a healthy live API checked recently", () => {
    render(<HealthBadge state="live" health="healthy" checkedAt={new Date("2026-10-06T11:59:00Z")} now={now} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says Down when the monitor marked it down", () => {
    render(<HealthBadge state="live" health="down" checkedAt={new Date("2026-10-06T11:59:00Z")} now={now} />);
    expect(screen.getByText("Down")).toBeInTheDocument();
  });

  it("warns when the last check is older than 10 minutes", () => {
    render(<HealthBadge state="live" health="healthy" checkedAt={new Date("2026-10-06T11:40:00Z")} now={now} />);
    expect(screen.getByRole("note")).toHaveTextContent("The last health check was more than 10 minutes ago");
  });

  it("shows the onboarding stage before the API is live", () => {
    render(<HealthBadge state="registering" health="healthy" checkedAt={null} now={now} />);
    expect(screen.getByText("Registering on the Masumi network")).toBeInTheDocument();
  });
});
