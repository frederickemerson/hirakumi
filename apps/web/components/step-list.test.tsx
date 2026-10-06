// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OnboardStep } from "@/lib/types";
import { StepList } from "./step-list";

const at = new Date("2026-10-06T10:00:00Z");
const steps: OnboardStep[] = [
  { step: "fetch_openapi", status: "done", output: null, updatedAt: at },
  { step: "describe_endpoints", status: "done", output: null, updatedAt: at },
  { step: "qa_tests", status: "running", output: null, updatedAt: at },
  { step: "build_rule", status: "pending", output: null, updatedAt: at },
];

describe("StepList", () => {
  it("renders nothing without steps", () => {
    const { container } = render(<StepList steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows steps done out of total as a progress bar", () => {
    render(<StepList steps={steps} />);
    expect(screen.getByText("2 of 4 steps done")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Listing progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
    expect(bar).toHaveAttribute("aria-valuetext", "2 of 4 done, now qa tests");
    expect(bar.querySelectorAll("[data-status=done]")).toHaveLength(2);
    expect(bar.querySelector("[data-status=running]")).toHaveClass("stripes-sky");
  });

  it("lists every step with its plain-English status and times the running one", async () => {
    render(<StepList steps={steps} />);
    expect(screen.getByText("Qa tests")).toBeInTheDocument();
    expect(screen.getByText("Build rule")).toBeInTheDocument();
    expect(screen.getAllByText("Done")).toHaveLength(2);
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    const running = screen.getByText("Qa tests").closest("li")!;
    expect(running).toHaveTextContent("In progress");
    // The elapsed hint appears after hydration and counts from the step's last update.
    expect(await screen.findByText(/\d+m \d{2}s|\d+s/)).toBeInTheDocument();
  });

  it("marks a failed step", () => {
    render(<StepList steps={[{ step: "fetch_openapi", status: "failed", output: { error: "404" }, updatedAt: at }]} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("progressbar").querySelector("[data-status=failed]")).toHaveClass("bg-coral");
  });
});
