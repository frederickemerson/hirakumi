// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageAt, TryConsole, type TryOp } from "./try-console";

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
    render(<TryConsole apiId="api_1" ops={[op]} hasDemoCredits />);
    await userEvent.selectOptions(screen.getByRole("combobox"), "BTC");
    await userEvent.click(screen.getByRole("button", { name: "Call it with a demo credit" }));
    expect(await screen.findByText("Promise kept. One credit used.")).toBeInTheDocument();
    expect(screen.getByText("312 ms")).toBeInTheDocument();
    expect(screen.getByText("96")).toBeInTheDocument();
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

  it("moves through the stages as time passes", () => {
    expect([stageAt(0), stageAt(500), stageAt(2500)]).toEqual([0, 1, 2]);
  });
});
