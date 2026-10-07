// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAuthForTests, setAuth } from "@/lib/auth-client";
import { OFFLINE_FAQ } from "@/lib/ask/facts";
import { LANDING_QUESTIONS } from "@/lib/ask/shared";
import Home from "./page";

const TRY = "Buy a real pack in your browser";
const section = (name: string) => screen.getByRole("heading", { name }).closest("section")!;

describe("Home", () => {
  beforeEach(() => resetAuthForTests());

  it("sends a signed-in seller straight to a new listing, not to the login page", () => {
    render(<Home />);
    act(() => setAuth({ status: "in", address: "addr_test1qz…tuqq5x" }));
    const ctas = screen.getAllByRole("link", { name: "List your API" });
    expect(ctas.length).toBeGreaterThan(1);
    for (const cta of ctas) expect(cta).toHaveAttribute("href", "/apis/new");
  });

  it("leads with the promise: any API in under 3 minutes, paid only when the promise is kept", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "Monetize any API in under 3 minutes" })).toBeInTheDocument();
    const hero = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(hero).toHaveTextContent("You set a promise. AI agents pay only when you keep it.");
    expect(hero).toHaveTextContent("No change to your code. One DNS record. Sign in with Google or email.");
    const ctas = screen.getAllByRole("link", { name: "List your API" });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) expect(cta).toHaveAttribute("href", "/login");
    expect(within(hero).getByRole("link", { name: TRY })).toHaveAttribute("href", "/p/api_eejiaioyqt/try");
  });

  it("keeps jargon out of the hero and dashes out of the page", () => {
    render(<Home />);
    const hero = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(hero.textContent).not.toMatch(/x402|IOU|Masumi agent|escrow|req\/s/i);
    expect(document.body.textContent).not.toMatch(/[–—]/);
  });

  it("points visitors at the live demo API's try page and status page", () => {
    render(<Home />);
    const tries = screen.getAllByRole("link", { name: TRY });
    expect(tries.length).toBeGreaterThan(2);
    for (const link of tries) expect(link).toHaveAttribute("href", "/p/api_eejiaioyqt/try");
    expect(screen.getByRole("link", { name: "See a live status page" })).toHaveAttribute("href", "/p/api_eejiaioyqt");
  });

  it("states the enterprise problem with its source and the trust gap", () => {
    render(<Home />);
    const why = section("Good APIs, stuck behind a project");
    expect(why).toHaveTextContent(/siloed codebases: billing, wallets, refunds and an agent wrapper/);
    expect(why).toHaveTextContent(/security review/);
    const read = (el: Element) => `${el.querySelector("dd .sr-only")!.textContent}${el.querySelector("dd")!.lastElementChild!.textContent === "%" ? "%" : ""}`;
    expect([...why.querySelectorAll("[data-stat]")].map(read)).toEqual(["897", "29%", "39%"]);
    expect(why).toHaveTextContent("Source: MuleSoft, 2025.");
    expect(why).toHaveTextContent("An AI can write you an agent, but it can't be its own trust layer.");
  });

  it("walks a seller from API to Masumi agent in five steps, and from a Sokosumi task", () => {
    render(<Home />);
    const how = section("From API to Masumi agent");
    expect(within(how).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Bring any API",
      "Prove it's yours",
      "Seal the key",
      "Set the promise",
      "Publish",
      "Already on Sokosumi? Do it from a task.",
    ]);
    expect(how).toHaveTextContent(/One DNS TXT record, then one signature binds your payout address/);
    expect(how).toHaveTextContent(/Google or email through UTXOS/);
  });

  it("describes the buyer side and hybrid settlement", () => {
    render(<Home />);
    const trust = section("Buyers pay once, then only for good answers");
    expect(trust.id).toBe("trust");
    expect(trust).toHaveTextContent(/402 with the price and the promise/);
    expect(trust).toHaveTextContent(/A 422, and nothing is charged/);
    expect(trust).toHaveTextContent("Hybrid settlement");
    expect(trust).toHaveTextContent("Nobody can take more than the agent agreed to, not even us.");
  });

  it("compares x402, Masumi and Hirakumi", () => {
    render(<Home />);
    const table = within(section("Each layer adds what the last one lacks")).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "x402payments",
      "Masumiagent directory",
      "Hirakumidone for you",
    ]);
    const trust = within(table).getByRole("row", { name: /Independent trust layer/ });
    expect(within(trust).getAllByText(/^(Yes|No)$/).map((e) => e.textContent)).toEqual(["No", "No", "Yes"]);
  });

  it("proves it on preprod: three measured numbers and two transactions anyone can check", () => {
    render(<Home />);
    const proof = section("Live on Cardano preprod");
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
    expect(within(proof).getByRole("link", { name: "registered on Masumi" })).toHaveAttribute(
      "href",
      "https://preprod.cardanoscan.io/transaction/8f04206b27e66266d61f22423c01447cad88582fb9c7fd7b96b7ac1f728e602a",
    );
    expect(within(proof).getByRole("link", { name: "The safe settled Mika's pack" })).toHaveAttribute(
      "href",
      "https://preprod.cardanoscan.io/transaction/d64f790605dbda025dbf92272c0546ea0fe02ab6f10984516df064da0fa4fdaa",
    );
  });

  it("names the use cases and the economics", () => {
    render(<Home />);
    const uses = section("Open an API to agents, without a modernization project");
    for (const who of ["Banks and exchanges", "Logistics and travel", "Data providers", "Any developer or hobbyist"]) {
      expect(within(uses).getByRole("heading", { name: who })).toBeInTheDocument();
    }
    expect(uses).toHaveTextContent("100x cheaper than paying for every call");
    expect(uses).toHaveTextContent("3% fee, only on good answers");
    expect(uses).toHaveTextContent("A small listing fee per API");
  });

  it("is honest about the network and today's ownership proof", () => {
    const { container } = render(<Home />);
    expect(screen.getByText("Is this on mainnet?")).toBeInTheDocument();
    expect(screen.getByText(/Everything runs on Cardano preprod, a test network/)).toBeInTheDocument();
    expect(screen.queryByText(/mainnet/i, { selector: "dd" })).toBeNull();
    expect(container.textContent).not.toMatch(/one file on your domain|download|well-known|OpenAPI file or serve|small file|header with a code|send a header/i);
  });

  it("answers its FAQ in the same words as Ask Hirakumi's offline FAQ", () => {
    const { container } = render(<Home />);
    const faq = [...container.querySelectorAll("[data-faq]")].map((el) => [el.querySelector("dt")!.textContent!, el.querySelector("dd")!.textContent!]);
    for (const q of LANDING_QUESTIONS) expect(faq.map(([fq]) => fq)).toContain(q);
    for (const [q, a] of faq) expect(OFFLINE_FAQ[q], q).toBe(a);
  });

  it("shows the receipt that explains the product", () => {
    render(<Home />);
    expect(screen.getByText("Buyer receipt")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Paid calls" }).children).toHaveLength(4);
    expect(screen.getByText("Credits left")).toBeInTheDocument();
  });
});
