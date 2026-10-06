// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { AUTO_CHECK_MS, OwnershipPanel, specSnippets } from "./ownership-panel";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const SPEC_URL = "https://price.example.dev/openapi.json";
const CODE = "hkv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PASS = { ok: true, reason: "verified", triedUrl: SPEC_URL, detail: "Found your code. The OpenAPI file is verified." };
const MISSING = { ok: false, reason: "missing", triedUrl: SPEC_URL, detail: "We read your OpenAPI file, but it has no x-hirakumi-verify field at the root." };
const MISMATCH = { ok: false, reason: "mismatch", triedUrl: SPEC_URL, detail: "Found x-hirakumi-verify, but its value does not match this API's code." };
const NOT_FOUND = { ok: false, reason: "http_status", status: 404, triedUrl: SPEC_URL, detail: "Your server answered 404, not 200." };
const REDIRECT = { ok: false, reason: "redirect", status: 301, triedUrl: SPEC_URL, detail: "Your server answered 301 (a redirect). Hirakumi does not follow redirects." };

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

const panel = (passed = false) => <OwnershipPanel apiId="api_1" openapiUrl={SPEC_URL} code={CODE} initiallyPassed={passed} />;
const checkCalls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter((c) => String(c[0]).endsWith("/ownership/spec-check")).length;

afterEach(() => {
  delete window.cardano;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setVisibility("visible");
  nav.push.mockReset();
});

describe("OwnershipPanel: what, where, why", () => {
  it("shows the code as YAML and JSON, the file it goes in, and why, with no file download", () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    render(panel());
    expect(screen.getByText(SPEC_URL)).toBeInTheDocument();
    expect(screen.getByText("So nobody can sell an API they don't own.")).toBeInTheDocument();
    expect(screen.getByText(`x-hirakumi-verify: "${CODE}"`)).toBeInTheDocument();
    expect(screen.getByText(`"x-hirakumi-verify": "${CODE}",`)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/[–—]/);
  });

  it("builds the snippets from the code", () => {
    expect(specSnippets(CODE)).toEqual({ yaml: `x-hirakumi-verify: "${CODE}"`, json: `"x-hirakumi-verify": "${CODE}",` });
  });

  it("copies a snippet", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(panel());
    await user.click(screen.getByRole("button", { name: "Copy YAML" }));
    expect(writeText).toHaveBeenCalledWith(`x-hirakumi-verify: "${CODE}"`);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
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
    expect(await screen.findByText(/^Checking https:\/\/price\.example\.dev\/openapi\.json…/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(await screen.findByText(/last checked 4 s ago/)).toBeInTheDocument();
  });

  it("stops checking once the code is found", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installWallet();
    const fetchMock = vi.fn(async () => jsonResponse(PASS));
    vi.stubGlobal("fetch", fetchMock);
    render(panel());
    expect(await screen.findByText("Found your code.")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * AUTO_CHECK_MS); });
    expect(checkCalls(fetchMock)).toBe(1);
  });

  it("does not check at all when the check already passed", async () => {
    installWallet();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(panel(true));
    expect(screen.getByText("Found your code.")).toBeInTheDocument();
    expect(checkCalls(fetchMock)).toBe(0);
  });
});

describe("OwnershipPanel: failures say exactly what was found", () => {
  it.each([
    [NOT_FOUND, "We couldn't fetch the file. Your server answered 404."],
    [REDIRECT, "We couldn't fetch the file. Your server answered 301, a redirect."],
    [MISSING, "We read the file, but x-hirakumi-verify is missing at the root."],
    [MISMATCH, "We found x-hirakumi-verify, but the code doesn't match this API's code."],
  ])("%#: %s", async (result, headline) => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(result)));
    render(panel());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(headline);
    expect(alert).toHaveTextContent("Redirects are not followed.");
    expect(alert).toHaveTextContent("Use HTTPS.");
    expect(alert).toHaveTextContent("Publish the updated file.");
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

describe("OwnershipPanel: check now and signing", () => {
  it("Check now runs a check right away; a pass shows ✓ and unlocks the wallet", async () => {
    installWallet();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(MISSING))
      .mockResolvedValueOnce(jsonResponse(PASS));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(panel());
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Sign with eternl" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Found your code.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    const step1 = screen.getByRole("listitem", { name: "Add your code" });
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
    expect(await screen.findByText("Found your code.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign with eternl" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/review"));
    expect(signData).toHaveBeenCalledWith("00beef", Buffer.from("Hirakumi ownership\napi: api_1").toString("hex"));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ challengeId: "ch_1", address: "00beef", signature: "84a1", key: "a401" });
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
