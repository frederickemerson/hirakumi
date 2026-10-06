// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("Home", () => {
  it("invites the seller to list an API", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "Put your API on the agent market" })).toBeInTheDocument();
    const ctas = screen.getAllByRole("link", { name: "Put your API on the market" });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) expect(cta).toHaveAttribute("href", "/login");
  });

  it("points buyers at the live demo API and the try page", () => {
    render(<Home />);
    for (const link of screen.getAllByRole("link", { name: "See a live API" })) {
      expect(link).toHaveAttribute("href", "/p/api_eejiaioyqt");
    }
    expect(screen.getByRole("link", { name: "Try it live" })).toHaveAttribute("href", "/p/api_eejiaioyqt/try");
  });

  it("walks through the flow and is honest about the network", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "How it works" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Two ways agents buy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pay only for kept promises" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Status that tells the truth" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Money goes straight to your wallet" })).toBeInTheDocument();
    expect(screen.getByText(/Cardano preprod, a test network/)).toBeInTheDocument();
  });
});
