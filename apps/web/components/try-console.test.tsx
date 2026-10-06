// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TryConsole, type TryOp } from "./try-console";

const op: TryOp = {
  opId: "getPrice", method: "GET", path: "/price", description: "Latest price", promise: "A fresh USD price",
  fields: [{ name: "symbol", required: true, options: ["ADA", "BTC"], example: "ADA", description: null, json: false }],
};
const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const TX = "cd".repeat(32);
const HASH = "e3".repeat(32);

const kept = (creditsLeft: number) => ok({
  status: 200, latencyMs: 312, creditsRemaining: creditsLeft, body: { usd: 0.27 },
  result: { kind: "kept", headline: "Promise kept. One credit used.", reasons: [] },
  receipt: { verdict: "kept", creditsLeft, outputHash: HASH, receiptsUrl: "/api/try/api_1/receipts" },
  request: { method: "GET", url: "https://gw/a/api_1/x/getPrice?symbol=BTC" },
});

/** A buy stream the test feeds one event at a time, like the gateway does while the payment settles. */
function controlledStream() {
  let c!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(ctrl) { c = ctrl; } });
  const enc = new TextEncoder();
  return {
    response: new Response(body, { headers: { "content-type": "application/x-ndjson" } }),
    send: async (e: unknown) => { await act(async () => { c.enqueue(enc.encode(`${JSON.stringify(e)}\n`)); await new Promise((r) => setTimeout(r, 0)); }); },
    close: async () => { await act(async () => { c.close(); await new Promise((r) => setTimeout(r, 0)); }); },
  };
}

const PACK = { credits: 97, txHash: TX, pending: false };

describe("TryConsole", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has no unpaid button: an API that is live is used like a real agent would", () => {
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={PACK} />);
    expect(screen.queryByRole("button", { name: /unpaid/i })).toBeNull();
    expect(screen.queryByText(/unpaid agent/i)).toBeNull();
    render(<TryConsole apiId="api_2" ops={[op]} initialPack={null} />);
    expect(screen.queryByRole("button", { name: /unpaid/i })).toBeNull();
  });

  it("with a pack, calls with a credit and shows the receipt: verdict, credits left, output hash, receipts link", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(kept(96));
    vi.stubGlobal("fetch", fetchMock);
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={PACK} />);
    expect(screen.getByText(/credits left in the live pack/)).toHaveTextContent("97 credits left in the live pack.");
    expect(screen.getByRole("link", { name: "Pack payment on Cardanoscan" })).toHaveAttribute("href", `https://preprod.cardanoscan.io/transaction/${TX}`);
    await userEvent.selectOptions(screen.getByRole("combobox"), "BTC");
    await userEvent.click(screen.getByRole("button", { name: "Call it" }));
    expect(await screen.findByText("Promise kept. One credit used.")).toBeInTheDocument();
    expect(screen.getByText("Kept")).toBeInTheDocument();
    expect(screen.getByText("312 ms")).toBeInTheDocument();
    expect(screen.getByTestId("output-hash")).toHaveTextContent(HASH);
    expect(screen.getByRole("link", { name: "See this pack's receipts" })).toHaveAttribute("href", "/api/try/api_1/receipts");
    expect(screen.getByText(/credits left in the live pack/)).toHaveTextContent("96 credits left in the live pack.");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/try/api_1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ opId: "getPrice", method: "GET", input: { symbol: "BTC" } });
  });

  it("without a pack, buys one live with Paying, Settling on Cardano, Settled in N s and the tx link, then makes the call", async () => {
    const stream = controlledStream();
    const fetchMock = vi.fn((url: string) => Promise.resolve(url.endsWith("/buy") ? stream.response : kept(99)));
    vi.stubGlobal("fetch", fetchMock);
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} packPrice={{ calls: 100, priceMicros: "2000000" }} />);
    expect(screen.getByText(/A real x402 payment of 2 tUSDM for 100 calls on Cardano preprod/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    // Pressed at once, before the server says anything.
    const pressed = screen.getByRole("button", { name: /Buying a pack/ });
    expect(pressed).toBeDisabled();
    expect(pressed).toHaveAttribute("aria-busy", "true");
    const card = screen.getByTestId("purchase");
    expect(within(card).getByLabelText("Elapsed")).toHaveTextContent(/^\d+\.\d s$/);
    const state = (label: string | RegExp) => within(card).getByText(label).closest("li")!.getAttribute("data-state");
    expect(state("Paying from the demo wallet")).toBe("active");

    await stream.send({ phase: "paying", packId: "pk_1", calls: 100, priceMicros: "2000000", wallet: "addr_test1q" });
    await stream.send({ phase: "settling" });
    expect(state("Paying from the demo wallet")).toBe("done");
    expect(state("Settling on Cardano")).toBe("active");

    await stream.send({ phase: "settled", txHash: TX, credits: 100, ms: 21_400, recovered: false });
    await stream.close();
    expect(await within(card).findByText("Settled in 21.4 s")).toBeInTheDocument();
    expect(state("Settled in 21.4 s")).toBe("done");
    expect(within(card).getByRole("link", { name: /on Cardanoscan/ })).toHaveAttribute("href", `https://preprod.cardanoscan.io/transaction/${TX}`);

    expect(await screen.findByText("Promise kept. One credit used.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/try/api_1/buy", "/api/try/api_1"]);
    expect(screen.getByRole("button", { name: "Call it" })).toBeEnabled();
    expect(screen.getByText(/credits left in the live pack/)).toHaveTextContent("99 credits left");
  });

  it("reuses a pack the gateway already holds instead of buying again", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/buy") ? stream.response : kept(41))));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    await stream.send({ phase: "ready", txHash: TX, credits: 42, pending: false, boughtAt: "2026-10-06T10:00:00Z" });
    await stream.close();
    expect(await screen.findByText("Using the live pack: 42 credits left.")).toBeInTheDocument();
    expect(await screen.findByText("Promise kept. One credit used.")).toBeInTheDocument();
  });

  it("shows a refusal (limits, low funds) as a clear message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok({ error: "The demo wallet has 2.5 tADA. It needs at least 3 tADA for fees, so nothing was bought." }, 409)));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("needs at least 3 tADA");
    expect(screen.queryByTestId("purchase")).toBeNull();
    expect(screen.getByRole("button", { name: "Buy a pack live" })).toBeEnabled();
  });

  it("never hangs: a stream that ends without a result says what to do", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(stream.response));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    await stream.send({ phase: "settling" });
    await stream.close();
    expect(await screen.findByText(/Lost the connection to the purchase/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy a pack live" })).toBeEnabled();
  });

  it("a payment that was sent but not confirmed says it is saved and won't be paid twice", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(stream.response));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    await stream.send({ phase: "settling" });
    await stream.send({ phase: "failed", spent: true, message: "The payment was sent but not confirmed yet. It is saved, and the next try picks it up without paying twice." });
    await stream.close();
    expect(await screen.findByText(/without paying twice/)).toBeInTheDocument();
    expect(within(screen.getByTestId("purchase")).getByText("Settling on Cardano").closest("li")).toHaveAttribute("data-state", "failed");
  });

  it("shows an honest Calling state with elapsed time in the result slot", async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={PACK} />);
    expect(screen.getByText("The answer and its receipt appear here.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Call it" }));
    expect(screen.getByRole("button", { name: /Calling/ })).toBeDisabled();
    expect(screen.getByText("Calling GET /price")).toBeInTheDocument();
    expect(screen.getByText(/^\d+\.\d s$/)).toBeInTheDocument();
    await act(async () => resolve(ok({
      status: 503, latencyMs: 40, creditsRemaining: null, body: {},
      result: { kind: "down", headline: "The API is Down right now. No credit used.", reasons: [] },
      receipt: { verdict: "no_charge", creditsLeft: null, outputHash: null, receiptsUrl: "/api/try/api_1/receipts" },
      request: { method: "GET", url: "u" },
    })));
    expect(await screen.findByText("The API is Down right now. No credit used.")).toBeInTheDocument();
    expect(screen.getByText("No charge")).toBeInTheDocument();
  });

  it("when the API is Down, the action is disabled and says why", () => {
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={PACK} downReason="Down right now. You can try it again once it passes its checks." />);
    const button = screen.getByRole("button", { name: "Call it" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Down right now. You can try it again once it passes its checks.");
  });

  it("uses no em or en dashes in its copy", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/buy") ? stream.response : kept(99))));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} packPrice={{ calls: 100, priceMicros: "2000000" }} />);
    expect(document.body.textContent).not.toMatch(/[\u2013\u2014]/);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    await stream.send({ phase: "settling" });
    await stream.send({ phase: "settled", txHash: TX, credits: 100, ms: 9_000, recovered: false });
    await stream.close();
    await screen.findByText("Promise kept. One credit used.");
    expect(document.body.textContent).not.toMatch(/[\u2013\u2014]/);
  });
});
