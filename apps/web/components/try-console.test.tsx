// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TryConsole, type TryOp } from "./try-console";

const op: TryOp = {
  opId: "getPrice", method: "GET", path: "/price", description: "Latest price", promise: "A fresh USD price",
  fields: [{ name: "symbol", required: true, options: ["ADA", "BTC"], example: "ADA", description: null, json: false }],
};
const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("TryConsole", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls with a demo credit and shows the kept promise, latency and credits left", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({
      status: 200, latencyMs: 312, creditsRemaining: 96, body: { usd: 0.27 },
      result: { kind: "kept", headline: "Promise kept. One credit used.", reasons: [] },
      request: { method: "GET", url: "https://gw/a/api_1/x/getPrice?symbol=BTC" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TryConsole apiId="api_1" ops={[op]} hasDemoCredits initialCredits={97} />);
    expect(screen.getByText("Demo credits left:")).toHaveTextContent("Demo credits left: 97");
    await userEvent.selectOptions(screen.getByRole("combobox"), "BTC");
    await userEvent.click(screen.getByRole("button", { name: "Call it with a demo credit" }));
    expect(await screen.findByText("Promise kept. One credit used.")).toBeInTheDocument();
    expect(screen.getByText("312 ms")).toBeInTheDocument();
    expect(screen.getAllByText("96")).toHaveLength(2); // the result and the running count both moved
    expect(screen.getByText("Demo credits left:")).toHaveTextContent("Demo credits left: 96");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ opId: "getPrice", method: "GET", input: { symbol: "BTC" }, paid: true });
  });

  it("without demo credits only offers the unpaid call", () => {
    render(<TryConsole apiId="api_1" ops={[op]} hasDemoCredits={false} />);
    expect(screen.queryByRole("button", { name: "Call it with a demo credit" })).toBeNull();
    expect(screen.getByRole("button", { name: "See what an unpaid agent gets" })).toBeInTheDocument();
  });

  it("shows the server's error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok({ error: "One paid try every few seconds, please." }, 429)));
    render(<TryConsole apiId="api_1" ops={[op]} hasDemoCredits />);
    await userEvent.click(screen.getByRole("button", { name: "Call it with a demo credit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("One paid try every few seconds");
  });

  it("shows one honest Calling state with elapsed time, in the result slot", async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    render(<TryConsole apiId="api_1" ops={[op]} hasDemoCredits={false} />);
    expect(screen.getByText("The answer appears here.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "See what an unpaid agent gets" }));
    expect(screen.getAllByText("Calling…").length).toBeGreaterThan(0);
    expect(screen.getByText(/^\d+\.\d s$/)).toBeInTheDocument();
    expect(screen.queryByText(/Checking the credit|Checking the answer/)).toBeNull();
    resolve(ok({ status: 503, latencyMs: 40, creditsRemaining: null, body: {}, result: { kind: "down", headline: "The API is Down right now, so nobody is charged.", reasons: [] }, request: { method: "GET", url: "u" } }));
    expect(await screen.findByText("The API is Down right now, so nobody is charged.")).toBeInTheDocument();
  });

  it("renders the 402 offer as a pack card from its fields, with the raw JSON behind a disclosure", async () => {
    const body = {
      error: "credits_required",
      packs: [{ packId: "pk_1", calls: 100, price: "2000000", asset: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d", buyUrl: "https://gw/a/api_1/packs/pk_1" }],
      ruleHash: "sha256:abc", ruleUrl: "https://gw/r/sha256:abc",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok({
      status: 402, latencyMs: 102, creditsRemaining: null, body,
      result: { kind: "payment_required", headline: "Payment required. This is the offer a buying agent sees.", reasons: [] },
      request: { method: "GET", url: "https://gw/a/api_1/x/getPrice?symbol=ADA" },
    })));
    render(<TryConsole apiId="api_1" ops={[op]} hasDemoCredits={false} />);
    await userEvent.click(screen.getByRole("button", { name: "See what an unpaid agent gets" }));
    expect(await screen.findByText("2 tUSDM · 100 calls")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /The promise the answer is checked against/ })).toHaveAttribute("href", "https://gw/r/sha256:abc");
    const raw = screen.getByText("Show the raw 402 answer").closest("details")!;
    expect(raw).not.toHaveAttribute("open");
    expect(raw).toHaveTextContent('"price": "2000000"');
  });
});
