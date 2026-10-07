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
    render(<TryConsole apiId="api_2" ops={[op]} initialPack={null} liveBuy />);
    expect(screen.queryByRole("button", { name: /unpaid/i })).toBeNull();
  });

  it("on an API that isn't featured, offers no live purchase and says why, with a link to the buyer snippet (audit I2)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} liveBuy={false} />);
    expect(screen.queryByRole("button", { name: "Buy a pack live" })).toBeNull();
    expect(screen.getByText(/Live purchases are funded by Hirakumi's demo wallet, so they're on featured APIs only\. Agents buy with their own wallet: see the/))
      .toBeInTheDocument();
    expect(screen.getByRole("link", { name: "code snippet" })).toHaveAttribute("href", "/p/api_1#buyer-snippet");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on an API that isn't featured, an existing demo pack still works", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(kept(96)));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={PACK} liveBuy={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Call it" }));
    expect(await screen.findByText("Promise kept. One credit used.")).toBeInTheDocument();
  });

  it("shows a text answer (CSV) as it came, with its format; a JSON answer shows no format line", async () => {
    const csv = "date,usd\n2026-10-07,0.27\n";
    const keptCsv = ok({
      status: 200, latencyMs: 90, creditsRemaining: 95, body: csv, contentType: "text/csv",
      result: { kind: "kept", headline: "Promise kept. One credit used.", reasons: [] },
      receipt: { verdict: "kept", creditsLeft: 95, outputHash: HASH, receiptsUrl: "/api/try/api_1/receipts" },
      request: { method: "GET", url: "https://gw/a/api_1/x/getPrice?symbol=ADA" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(kept(96)).mockResolvedValueOnce(keptCsv));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={PACK} />);
    await userEvent.click(screen.getByRole("button", { name: "Call it" }));
    expect(await screen.findByText("Promise kept. One credit used.")).toBeInTheDocument();
    expect(screen.queryByTestId("answer-format")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Call it" }));
    expect(await screen.findByTestId("answer-format")).toHaveTextContent("Answer format: CSV (text/csv)");
    expect(document.querySelector("pre code")?.textContent).toBe(csv);
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
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} liveBuy packPrice={{ calls: 100, priceMicros: "2000000" }} />);
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

  it("shows how the pack settles and why, once the gateway says (PACK_MODE=hybrid)", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/buy") ? stream.response : kept(99))));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} liveBuy />);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    await stream.send({ phase: "paying", packId: "pk_1", calls: 100, priceMicros: "2000000", wallet: "addr_test1q" });
    expect(screen.queryByTestId("settlement")).toBeNull();
    await stream.send({ phase: "settling", settlement: { mode: "escrow", reasons: ["new seller"] } });
    expect(screen.getByTestId("settlement")).toHaveTextContent("Settlement: escrow, because: new seller");
    await stream.send({ phase: "settled", txHash: TX, credits: 100, ms: 21_400, recovered: false });
    await stream.close();
    expect(await screen.findByText("Promise kept. One credit used.")).toBeInTheDocument();
    expect(screen.getByTestId("settlement")).toHaveTextContent("Settlement: escrow, because: new seller");
  });

  it("reuses a pack the gateway already holds instead of buying again", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/buy") ? stream.response : kept(41))));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} liveBuy />);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    await stream.send({ phase: "ready", txHash: TX, credits: 42, pending: false, boughtAt: "2026-10-06T10:00:00Z" });
    await stream.close();
    expect(await screen.findByText("Using the live pack: 42 credits left.")).toBeInTheDocument();
    expect(await screen.findByText("Promise kept. One credit used.")).toBeInTheDocument();
  });

  it("shows a refusal (limits, low funds) as a clear message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok({ error: "The demo wallet has 2.5 tADA. It needs at least 3 tADA for fees, so nothing was bought." }, 409)));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} liveBuy />);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("needs at least 3 tADA");
    expect(screen.queryByTestId("purchase")).toBeNull();
    expect(screen.getByRole("button", { name: "Buy a pack live" })).toBeEnabled();
  });

  it("a stream lost mid-way is pending, never an error, and is followed to its outcome without buying again", async () => {
    const stream = controlledStream();
    const urls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      urls.push(url);
      if (url === "/api/try/api_1/buy") return Promise.resolve(stream.response);
      if (url.includes("?resume=")) {
        return Promise.resolve(new Response(`${JSON.stringify({ phase: "settled", txHash: TX, credits: 100, ms: 0, recovered: true })}\n`, { headers: { "content-type": "application/x-ndjson" } }));
      }
      return Promise.resolve(kept(99));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} liveBuy resumeEveryMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    await stream.send({ phase: "paying", purchaseId: "try_p1", packId: "pk_1", calls: 100, priceMicros: "2000000", wallet: "addr_test1q" });
    await stream.send({ phase: "settling" });
    await stream.close();
    expect(await screen.findByText("Promise kept. One credit used.")).toBeInTheDocument();
    expect(urls).toEqual(["/api/try/api_1/buy", "/api/try/api_1/buy?resume=try_p1", "/api/try/api_1"]);
    expect(screen.queryByText(/Lost the connection/)).toBeNull();
  });

  it("a payment sent but not confirmed shows Pending, not an error or 'not charged', until it is confirmed", async () => {
    const stream = controlledStream();
    let answer: unknown = { phase: "pending", purchaseId: "try_p2", message: "The payment is sent and waiting for Cardano to confirm it." };
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/try/api_1/buy") return Promise.resolve(stream.response);
      if (url.includes("?resume=")) return Promise.resolve(new Response(`${JSON.stringify(answer)}\n`));
      return Promise.resolve(kept(99));
    }));
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} liveBuy resumeEveryMs={20} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    await stream.send({ phase: "settling" });
    await stream.send({ phase: "pending", purchaseId: "try_p2", message: "The payment is sent and waiting for Cardano to confirm it." });
    await stream.close();
    const pending = await screen.findByTestId("purchase-pending");
    expect(pending).toHaveTextContent(/^Pending\./);
    expect(pending).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/not charged|nothing was paid|failed/i);
    expect(within(screen.getByTestId("purchase")).getByText("Waiting for Cardano to confirm").closest("li")).toHaveAttribute("data-state", "active");
    answer = { phase: "failed", spent: false, message: "Hirakumi never received the payment, so nothing was paid." };
    expect(await screen.findByRole("alert")).toHaveTextContent("never received the payment");
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
    render(<TryConsole apiId="api_1" ops={[op]} initialPack={null} liveBuy packPrice={{ calls: 100, priceMicros: "2000000" }} />);
    expect(document.body.textContent).not.toMatch(/[\u2013\u2014]/);
    await userEvent.click(screen.getByRole("button", { name: "Buy a pack live" }));
    await stream.send({ phase: "settling" });
    await stream.send({ phase: "settled", txHash: TX, credits: 100, ms: 9_000, recovered: false });
    await stream.close();
    await screen.findByText("Promise kept. One credit used.");
    expect(document.body.textContent).not.toMatch(/[\u2013\u2014]/);
  });
});
