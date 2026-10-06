// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAuthForTests, setAuth } from "@/lib/auth-client";
import Home from "./page";

describe("Home", () => {
  beforeEach(() => resetAuthForTests());

  it("sends a signed-in seller straight to a new listing, not to the login page", () => {
    render(<Home />);
    act(() => setAuth({ status: "in", address: "addr_test1qz…tuqq5x" }));
    const ctas = screen.getAllByRole("link", { name: "List your API" });
    expect(ctas.length).toBeGreaterThan(1);
    for (const cta of ctas) expect(cta).toHaveAttribute("href", "/apis/new");
  });

  it("invites the seller to list an API", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "Make your APIs monetizable" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Paste an OpenAPI link or a few example requests, sign with your Cardano wallet, set a pack price. AI agents pay in USDM, and stale or empty answers cost them nothing.",
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

  it("says any API works: an OpenAPI link or a few example requests", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "Paste a link or example requests" })).toBeInTheDocument();
    expect(screen.getByText(/or your API's address and a few example requests/)).toBeInTheDocument();
  });

  it("walks through the flow and is honest about the network", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "How it works" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How the money is protected" })).toBeInTheDocument();
    expect(screen.getByText("Proven on preprod, rolling out next")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Fast, and fair" })).toBeInTheDocument();
    expect(screen.getByText("Is this on mainnet?")).toBeInTheDocument();
    expect(screen.getByText(/Everything runs on Cardano preprod, a test network/)).toBeInTheDocument();
    expect(screen.queryByText(/mainnet/i, { selector: "dd" })).toBeNull();
  });

  it("describes today's ownership proof: a header with a code, and one wallet signature", () => {
    const { container } = render(<Home />);
    expect(screen.getByText(/make your API send a header with a code, then sign once with your wallet/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/one file on your domain|download|well-known|OpenAPI file or serve|small file/i);
  });

  it("keeps the judge panel's cuts: no jargon, earnings or escrow claim in the hero", () => {
    render(<Home />);
    const hero = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(hero.textContent).not.toMatch(/x402|IOU|Masumi agent|escrow|earn|req\/s/i);
    expect(hero.textContent).not.toMatch(/promise/i);
    expect(document.body.textContent).not.toMatch(/[\u2013\u2014]/);
  });

  it("proves speed with exactly three measured numbers", () => {
    render(<Home />);
    const proof = screen.getByRole("heading", { name: "Fast, and fair" }).closest("section")!;
    expect(proof).toHaveTextContent("Measured on Cardano preprod with test funds.");
    const stats = proof.querySelectorAll("[data-stat]");
    expect(stats).toHaveLength(3);
    // The counting digits are hidden from screen readers; the final value sits beside them as text.
    const read = (el: Element) => {
      const dd = el.querySelector("dd")!;
      return [`${dd.querySelector(".sr-only")!.textContent} ${dd.lastElementChild!.textContent}`, el.querySelector("dt")!.textContent];
    };
    expect(read(stats[0])).toEqual(["9.4 s", "for an agent's payment to settle on Cardano"]);
    expect(read(stats[1])).toEqual(["0.3 s", "per paid call, end to end"]);
    expect(read(stats[2])).toEqual(["0 credits", "charged for a stale or broken answer"]);
    expect(proof.textContent).not.toMatch(/tUSDM|422|Refunded|req\/s/);
  });

  it("shows the receipt that explains the product", () => {
    render(<Home />);
    expect(screen.getByText("Buyer receipt")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Paid calls" }).children).toHaveLength(4);
    expect(screen.getByText("Credits left")).toBeInTheDocument();
  });
});
