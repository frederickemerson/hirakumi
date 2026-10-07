// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import type { DnsSetup } from "@/lib/dns-provider";
import { ASK_EVENT } from "./ask-hirakumi";
import { AUTO_CHECK_MS, digCheck, helpQuestion, OwnershipPanel, vercelDnsCommand } from "./ownership-panel";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const HOST = "price.example.dev";
const RECORD = "_hirakumi.price.example.dev";
const CODE = "hkv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PASS = { ok: true, reason: "verified", record: RECORD, detail: `Found your code in the TXT record at ${RECORD}.` };
const MISSING = { ok: false, reason: "missing", record: RECORD, detail: `No TXT record found at ${RECORD} yet.` };
const MISMATCH = { ok: false, reason: "mismatch", record: RECORD, detail: `Found a TXT record at ${RECORD}, but not with this API's code.` };
const TIMEOUT = { ok: false, reason: "timeout", record: RECORD, detail: `DNS did not answer for ${RECORD} in time.` };
const BAD_HOST = { ok: false, reason: "bad_host", record: "52.70.235.103", detail: "The API's address is an IP address, which has no DNS to add a record to. Give it a domain name." };

function installWallet(signData = vi.fn(async () => ({ signature: "84a1", key: "a401" }))) {
  window.cardano = {
    eternl: {
      name: "eternl",
      icon: "",
      enable: async () => ({
        getNetworkId: async () => 0,
        getChangeAddress: async () => "00beef",
        getUsedAddresses: async () => ["00beef"],
        signData,
      }),
    },
  };
  return signData;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const panel = (passed = false, dns?: Promise<DnsSetup>) =>
  <OwnershipPanel apiId="api_1" host={HOST} recordName={RECORD} code={CODE} initiallyPassed={passed} dns={dns} />;
const checkCalls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter((c) => String(c[0]).endsWith("/ownership/dns-check")).length;
const field = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement!;

afterEach(() => {
  delete window.cardano;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setVisibility("visible");
  nav.push.mockReset();
});

describe("OwnershipPanel: the record, where to add it, why", () => {
  it("shows a TXT record with the full name and the code, why, and a dig check; no header, snippet or AI prompt", () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    render(panel());
    expect(screen.getByText(/^So nobody can sell an API they don't own\./)).toHaveTextContent(`Add this TXT record to the DNS of ${HOST}.`);
    expect(field("Type")).toHaveTextContent("TXT");
    expect(within(field("Name")).getByText(RECORD)).toBeInTheDocument();
    expect(within(field("Value")).getByText(CODE)).toBeInTheDocument();
    expect(screen.getByText(`dig +short TXT '${RECORD}'`)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/X-Hirakumi-Verify|Let your AI do it|Open in Claude|curl/);
    expect(document.body.textContent).not.toMatch(/[–—]/);
  });

  it("copies the name, the value and the dig command", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(panel());
    await user.click(screen.getByRole("button", { name: "Copy name" }));
    expect(writeText).toHaveBeenLastCalledWith(RECORD);
    await user.click(screen.getByRole("button", { name: "Copy value" }));
    expect(writeText).toHaveBeenLastCalledWith(CODE);
    await user.click(screen.getByRole("button", { name: "Copy dig command" }));
    expect(writeText).toHaveBeenLastCalledWith(digCheck(RECORD));
  });

  it("names the provider, gives its steps, and shortens the name to what its dashboard asks for", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    render(panel(false, Promise.resolve({ zone: "example.dev", provider: "cloudflare", sharedSuffix: null })));
    expect(await screen.findByText("Cloudflare")).toBeInTheDocument();
    expect(screen.getByText(/DNS, Records, Add record\./)).toBeInTheDocument();
    expect(within(field("Name")).getByText("_hirakumi.price")).toBeInTheDocument();
    expect(field("Name")).toHaveTextContent(`The full name is ${RECORD}.`);
    expect(screen.queryByText(/vercel dns add/)).toBeNull();
  });

  it("gives the Vercel CLI command when the DNS is on Vercel", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    render(panel(false, Promise.resolve({ zone: "example.dev", provider: "vercel", sharedSuffix: null })));
    expect(await screen.findByText(vercelDnsCommand("example.dev", "_hirakumi.price", CODE))).toBeInTheDocument();
    expect(vercelDnsCommand("example.dev", "_hirakumi.price", CODE)).toBe(`vercel dns add example.dev _hirakumi.price TXT ${CODE}`);
  });

  it("says a platform's shared domain can't take the record, and what to do instead", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    render(<OwnershipPanel apiId="api_1" host="mine.vercel.app" recordName="_hirakumi.mine.vercel.app" code={CODE} initiallyPassed={false}
      dns={Promise.resolve({ zone: "vercel.app", provider: null, sharedSuffix: "vercel.app" })} />);
    expect(await screen.findByText("mine.vercel.app is on vercel.app, a platform's shared domain.")).toBeInTheDocument();
    expect(screen.getByText(/Connect your own domain to your API/)).toBeInTheDocument();
  });

  it("says it is finding the provider until the hint arrives, and gives general steps when there is none", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    let resolve!: (s: DnsSetup) => void;
    render(panel(false, new Promise<DnsSetup>((r) => { resolve = r; })));
    expect(screen.getByText(/Finding where your domain's DNS is managed/)).toBeInTheDocument();
    await act(async () => resolve({ zone: null, provider: null, sharedSuffix: null }));
    expect(screen.getByText(/often your registrar \(where you bought the domain\) or Cloudflare/)).toBeInTheDocument();
    expect(within(field("Name")).getByText(RECORD)).toBeInTheDocument();
  });

  it("Ask Hirakumi how opens the help chat with a question about the seller's own provider", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    const asked = vi.fn();
    const listener = (e: Event) => asked((e as CustomEvent).detail);
    window.addEventListener(ASK_EVENT, listener);
    const user = userEvent.setup();
    render(panel(false, Promise.resolve({ zone: "example.dev", provider: "porkbun", sharedSuffix: null })));
    await screen.findByText("Porkbun");
    await user.click(screen.getByRole("button", { name: "Ask Hirakumi how" }));
    expect(asked).toHaveBeenCalledWith({ question: "How do I add the _hirakumi TXT record on Porkbun?" });
    window.removeEventListener(ASK_EVENT, listener);
    expect(helpQuestion(null)).toBe("How do I add the _hirakumi TXT record for my API?");
  });

  it("shows the optional key section between adding the record and signing", () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    const { container } = render(<OwnershipPanel apiId="api_1" host={HOST} recordName={RECORD} code={CODE} initiallyPassed={false} beforeSigning={<p>Key section</p>} />);
    const items = Array.from(container.querySelectorAll<HTMLElement>(":scope > ol > li"));
    expect(items.map((li) => li.textContent?.includes("Key section"))).toEqual([false, true, false]);
    expect(within(items[2]).getByRole("heading", { name: "Sign with your wallet" })).toBeInTheDocument();
  });

  it("quotes the name in the dig check", () => {
    expect(digCheck("_hirakumi.it's.example")).toBe("dig +short TXT '_hirakumi.it'\\''s.example'");
  });
});

describe("OwnershipPanel: auto-check", () => {
  it("checks on open, then every 10 s while the page is visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installWallet();
    const fetchMock = vi.fn(async () => jsonResponse(MISSING));
    vi.stubGlobal("fetch", fetchMock);
    render(panel());
    await vi.waitFor(() => expect(checkCalls(fetchMock)).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_MS); });
    await vi.waitFor(() => expect(checkCalls(fetchMock)).toBe(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_MS); });
    await vi.waitFor(() => expect(checkCalls(fetchMock)).toBe(3));
  });

  it("pauses while the page is hidden and checks again when it is shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installWallet();
    const fetchMock = vi.fn(async () => jsonResponse(MISSING));
    vi.stubGlobal("fetch", fetchMock);
    render(panel());
    await vi.waitFor(() => expect(checkCalls(fetchMock)).toBe(1));
    act(() => setVisibility("hidden"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * AUTO_CHECK_MS); });
    expect(checkCalls(fetchMock)).toBe(1);
    act(() => setVisibility("visible"));
    await vi.waitFor(() => expect(checkCalls(fetchMock)).toBe(2));
  });

  it("says what it is checking and when it last checked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    render(panel());
    expect(await screen.findByText(new RegExp(`^Looking up ${RECORD.replace(/\./g, "\\.")}…`))).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(await screen.findByText(/^Last checked 4 s ago\./)).toBeInTheDocument();
  });

  it("stops checking once the record is found", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installWallet();
    const fetchMock = vi.fn(async () => jsonResponse(PASS));
    vi.stubGlobal("fetch", fetchMock);
    render(panel());
    expect(await screen.findByText("Found your record.")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * AUTO_CHECK_MS); });
    expect(checkCalls(fetchMock)).toBe(1);
  });

  it("does not check at all when the check already passed", async () => {
    installWallet();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(panel(true));
    expect(screen.getByText("Found your record.")).toBeInTheDocument();
    expect(checkCalls(fetchMock)).toBe(0);
  });
});

describe("OwnershipPanel: results say exactly what was found", () => {
  it.each([
    [MISSING, "Waiting", `No TXT record at ${RECORD} yet.`, "New records usually show within a few minutes"],
    [TIMEOUT, "Waiting", "DNS didn't answer this time. We'll look again.", "We'll look again"],
  ])("%#: not there yet is a calm wait, never an alert", async (result, tag, headline, next) => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(result)));
    render(panel());
    const card = (await screen.findByText(headline)).parentElement!;
    expect(card).toHaveAttribute("role", "status");
    expect(within(card).getByText(tag)).toBeInTheDocument();
    expect(card).toHaveTextContent(next);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await screen.findByRole("button", { name: "Sign with eternl" })).toBeDisabled();
  });

  it.each([
    [MISMATCH, "Wrong value", `There is a TXT record at ${RECORD}, but not with this API's code.`, false, "a name can hold several TXT records"],
    [BAD_HOST, "Can't check", "This address can't have a DNS record.", true, "Give your API a domain name in its setup"],
  ])("%#: a real failure is an alert", async (result, tag, headline, showsDetail, next) => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(result)));
    render(panel());
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(tag)).toBeInTheDocument();
    expect(alert).toHaveTextContent(headline);
    if (showsDetail) expect(alert).toHaveTextContent(result.detail);
    expect(alert).toHaveTextContent(next);
    expect(alert.textContent).not.toMatch(/[–—]/);
    expect(await screen.findByRole("button", { name: "Sign with eternl" })).toBeDisabled();
  });

  it("shows the gateway outage message", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "We couldn't reach the Hirakumi checker. Try again in a minute." }, 502)));
    render(panel());
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't reach the Hirakumi checker.");
  });
});

describe("OwnershipPanel: test it", () => {
  it("shows progress while a check runs, then a Found card with the next step", async () => {
    installWallet();
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    render(panel());
    const button = await screen.findByRole("button", { name: /Checking/ });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText(new RegExp(`^Looking up ${RECORD.replace(/\./g, "\\.")}…`))).toBeInTheDocument();
    await act(async () => answer(jsonResponse(PASS)));
    const found = await screen.findByText("Found your record.");
    expect(found.parentElement).toHaveTextContent("Sign with your wallet below to finish.");
    expect(found.parentElement).toHaveTextContent("Keep it in place while your API is listed.");
    expect(within(found.parentElement!).getByText("Found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });
});

describe("OwnershipPanel: check now and signing", () => {
  it("Check now runs a check right away; a pass shows ✓ and unlocks the wallet", async () => {
    installWallet();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(MISSING))
      .mockResolvedValueOnce(jsonResponse(PASS));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(panel());
    await screen.findByText(`No TXT record at ${RECORD} yet.`);
    expect(screen.getByRole("button", { name: "Sign with eternl" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Found your record.")).toBeInTheDocument();
    expect(screen.queryByText(`No TXT record at ${RECORD} yet.`)).toBeNull();
    const step1 = screen.getByRole("listitem", { name: "Add a DNS record" });
    expect(within(step1).getByText("✓")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign with eternl" })).toBeEnabled();
  });

  it("signs the server's message after a pass and opens Review", async () => {
    const signData = installWallet();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PASS))
      .mockResolvedValueOnce(jsonResponse({ challengeId: "ch_1", message: "Hirakumi ownership\napi: api_1" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ownership_verified" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(panel());
    expect(await screen.findByText("Found your record.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign with eternl" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/review"));
    expect(signData).toHaveBeenCalledWith("00beef", Buffer.from("Hirakumi ownership\napi: api_1").toString("hex"));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ challengeId: "ch_1", address: "00beef", signature: "84a1", key: "a401" });
  });

  it("a DNS pass that expired while the page was open is checked again, then signing goes on", async () => {
    installWallet();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PASS))
      .mockResolvedValueOnce(jsonResponse({ error: "Check your DNS record again." }, 409))
      .mockResolvedValueOnce(jsonResponse(PASS))
      .mockResolvedValueOnce(jsonResponse({ challengeId: "ch_2", message: "Hirakumi ownership\napi: api_1" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ownership_verified" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(panel());
    expect(await screen.findByText("Found your record.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign with eternl" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/review"));
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "/api/apis/api_1/ownership/dns-check", "/api/apis/api_1/ownership/wallet-challenge",
      "/api/apis/api_1/ownership/dns-check", "/api/apis/api_1/ownership/wallet-challenge", "/api/apis/api_1/ownership/verify",
    ]);
  });

  it("an expired pass whose record is gone sends the seller back to step 1, not a dead end", async () => {
    installWallet();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PASS))
      .mockResolvedValueOnce(jsonResponse({ error: "Check your DNS record again." }, 409))
      .mockResolvedValue(jsonResponse(MISSING));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(panel());
    expect(await screen.findByText("Found your record.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign with eternl" }));
    expect(await screen.findByText(/can't find your DNS record anymore/)).toBeInTheDocument();
    const step1 = screen.getByRole("listitem", { name: "Add a DNS record" });
    expect(within(step1).queryByText("✓")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign with eternl" })).toBeDisabled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("never flashes 'no wallet' before the wallets are found, and shows each wallet's icon", async () => {
    const view = render(panel(true));
    expect(screen.queryByText("No Cardano wallet found in this browser.")).toBeNull();
    installWallet();
    window.cardano!.eternl!.icon = "data:image/png;base64,QQ==";
    const button = await screen.findByRole("button", { name: "Sign with eternl" }, { timeout: 2000 });
    expect(button.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,QQ==");
    view.unmount();
  });

  it("ticks both steps once the signature is verified", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ challengeId: "ch_1", message: "m" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ownership_verified" })));
    render(panel(true));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign with eternl" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(screen.getAllByText("✓")).toHaveLength(2);
  });
});
