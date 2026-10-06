// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("Home", () => {
  it("invites the seller to list an API", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "Make your APIs monetizable" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Paste your OpenAPI link, sign with your Cardano wallet, set a pack price. AI agents pay in USDM, and stale or empty answers cost them nothing.",
      ),
    ).toBeInTheDocument();
    const ctas = screen.getAllByRole("link", { name: "List your API" });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) expect(cta).toHaveAttribute("href", "/login");
  });

  it("points visitors at the live demo API and its try page", () => {
    render(<Home />);
    const tries = screen.getAllByRole("link", { name: "Try a live API" });
    expect(tries.length).toBeGreaterThan(0);
    for (const link of tries) expect(link).toHaveAttribute("href", "/p/api_eejiaioyqt/try");
    expect(screen.getByRole("link", { name: "See a live status page" })).toHaveAttribute("href", "/p/api_eejiaioyqt");
  });

  it("walks through the flow and is honest about the network", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "How it works" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How the money is protected" })).toBeInTheDocument();
    expect(screen.getByText("Proven on preprod, rolling out next")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Measured on preprod" })).toBeInTheDocument();
    expect(screen.getByText("Is this on mainnet?")).toBeInTheDocument();
    expect(screen.getByText(/Everything runs on Cardano preprod, a test network/)).toBeInTheDocument();
    expect(screen.queryByText(/mainnet/i, { selector: "dd" })).toBeNull();
  });

  it("keeps the judge panel's cuts: no jargon, earnings or escrow claim in the hero", () => {
    render(<Home />);
    const hero = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(hero.textContent).not.toMatch(/x402|IOU|Masumi agent|escrow|earn|req\/s/i);
    expect(hero.textContent).not.toMatch(/promise/i);
    expect(document.body.textContent).not.toMatch(/[\u2013\u2014]/);
    expect(screen.getByText(/local load test, not preprod/)).toBeInTheDocument();
  });

  it("shows the receipt that explains the product", () => {
    render(<Home />);
    expect(screen.getByText("Buyer receipt")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Paid calls" }).children).toHaveLength(4);
    expect(screen.getByText("Credits left")).toBeInTheDocument();
  });
});
