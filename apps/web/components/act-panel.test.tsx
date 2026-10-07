// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { ActPanel, DONE_TEXT } from "./act-panel";
import { isFocusedPath } from "./site-chrome";

vi.mock("@utxos/sdk", () => ({ Web3Wallet: { enable: vi.fn() } }));

function installWallet() {
  window.cardano = {
    testwallet: {
      name: "Test Wallet",
      icon: "data:image/svg+xml;base64,AAAA",
      enable: async () => ({
        getNetworkId: async () => 0,
        getChangeAddress: async () => "00abcd",
        getUsedAddresses: async () => ["00abcd"],
        signData: async () => ({ signature: "84a1", key: "a401" }),
      }),
    },
  };
}

type Route = (body: Record<string, unknown>) => Response;
function routeFetch(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route(JSON.parse(String(init?.body ?? "{}")));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const sent = (m: ReturnType<typeof routeFetch>, url: string) => m.mock.calls.filter((c) => c[0] === url).map((c) => JSON.parse(String(c[1]!.body)));

beforeEach(() => {
  installWallet();
  vi.spyOn(window, "close").mockImplementation(() => undefined);
});
afterEach(() => {
  delete window.cardano;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ActPanel (one wallet step from a Sokosumi comment)", () => {
  it("ownership: names the wallet, takes the key named by the OpenAPI file, signs once and says the tab can close", async () => {
    const f = routeFetch({
      "/api/act/tok/challenge": () => jsonResponse({ kind: "wallet", challengeId: "ch_1", message: "Hirakumi ownership" }),
      "/api/act/tok": () => jsonResponse({ done: true }),
    });
    render(<ActPanel token="tok" action="ownership" title="Sign to prove you own weather.example.com" wallet="…abc123"
      keyHint={{ in: "header", name: "Authorization", prefix: "Bearer " }} />);
    expect(screen.getByRole("heading", { name: "Sign to prove you own weather.example.com" })).toBeInTheDocument();
    expect(screen.getByText("…abc123")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "My API needs a key" })).toBeChecked();
    expect(screen.getByDisplayValue("Authorization")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Key/), "sk_123");
    await userEvent.click(await screen.findByRole("button", { name: "Sign with Test Wallet" }, { timeout: 4000 }));
    expect(await screen.findByText(DONE_TEXT)).toBeInTheDocument();
    expect(sent(f, "/api/act/tok/challenge")).toEqual([{ address: "00abcd" }]);
    expect(sent(f, "/api/act/tok")).toEqual([{
      address: "00abcd", signature: "84a1", key: "a401", challengeId: "ch_1",
      upstreamAuth: { in: "header", name: "Authorization", value: "Bearer sk_123" }, saveAnyway: false,
    }]);
    expect(DONE_TEXT).toBe("Done. You can close this tab; the rest continues in Sokosumi.");
  });

  it("ownership without a key: nothing about a key is sent", async () => {
    const f = routeFetch({
      "/api/act/tok/challenge": () => jsonResponse({ kind: "wallet", challengeId: "ch_1", message: "m" }),
      "/api/act/tok": () => jsonResponse({ done: true }),
    });
    render(<ActPanel token="tok" action="ownership" title="Sign" wallet="…abc123" keyHint={null} />);
    expect(screen.getByRole("checkbox", { name: "My API needs a key" })).not.toBeChecked();
    await userEvent.click(await screen.findByRole("button", { name: "Sign with Test Wallet" }, { timeout: 4000 }));
    await screen.findByText(DONE_TEXT);
    expect(sent(f, "/api/act/tok")[0]).not.toHaveProperty("upstreamAuth");
  });

  it("publish: no key field, the sealed message token goes back with the signature", async () => {
    const f = routeFetch({
      "/api/act/p/challenge": () => jsonResponse({ kind: "act", nonceToken: "n.t", message: "Sign to publish" }),
      "/api/act/p": () => jsonResponse({ done: true }),
    });
    render(<ActPanel token="p" action="publish" title="Sign to publish weather.example.com at 2 tUSDM for 100 calls" wallet="…abc123" keyHint={null} />);
    expect(screen.queryByRole("group", { name: "Your API's key" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Sign with Test Wallet" }, { timeout: 4000 }));
    await screen.findByText(DONE_TEXT);
    expect(sent(f, "/api/act/p")).toEqual([{ address: "00abcd", signature: "84a1", key: "a401", nonceToken: "n.t" }]);
  });

  it("key: signing waits for the key; a key the API refused can be saved anyway on the next signature", async () => {
    let refuse = true;
    const f = routeFetch({
      "/api/act/k/challenge": () => jsonResponse({ kind: "act", nonceToken: "n.t", message: "Save the key" }),
      "/api/act/k": () => (refuse ? jsonResponse({ error: "Your API refused this key. Check it, or save it anyway.", code: "KEY_REFUSED" }, 409) : jsonResponse({ done: true })),
    });
    render(<ActPanel token="k" action="key" title="Add the key for weather.example.com" wallet="…abc123" keyHint={{ in: "query", name: "api_key" }} />);
    const button = await screen.findByRole("button", { name: "Sign with Test Wallet" }, { timeout: 4000 });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Key/), "abcd");
    await userEvent.click(button);
    expect(await screen.findByText("Your API refused this key. Check it, or save it anyway.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Save it anyway" }));
    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Sign with Test Wallet" }));
    await screen.findByText(DONE_TEXT);
    expect(sent(f, "/api/act/k").map((b) => b.saveAnyway)).toEqual([false, true]);
  });

  it("shows the server's refusal, such as the wrong wallet", async () => {
    routeFetch({
      "/api/act/tok/challenge": () => jsonResponse({ error: "This link is for the wallet ending …abc123. Switch to that wallet and sign again." }, 403),
    });
    render(<ActPanel token="tok" action="publish" title="Sign" wallet="…abc123" keyHint={null} />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign with Test Wallet" }, { timeout: 4000 }));
    expect(await screen.findByText("This link is for the wallet ending …abc123. Switch to that wallet and sign again.")).toBeInTheDocument();
    expect(screen.queryByText(DONE_TEXT)).toBeNull();
  });
});

describe("pages opened from a Sokosumi comment show no site around them", () => {
  it("hides the header, footer and help chat on /act/<token> and /setup only", () => {
    expect(isFocusedPath("/act/abc")).toBe(true);
    expect(isFocusedPath("/setup")).toBe(true);
    for (const p of ["/", "/apis", "/apis/api_1/review", "/login", "/actually", null]) expect(isFocusedPath(p)).toBe(false);
  });
});
