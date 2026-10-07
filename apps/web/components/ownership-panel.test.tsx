// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import type { PlatformHint } from "@/lib/header-platform";
import { agentPrompt, AUTO_CHECK_MS, claudeUrl, curlCheck, headerSnippets, OwnershipPanel } from "./ownership-panel";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const BASE_URL = "https://price.example.dev/v1";
const CODE = "hkv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PASS = { ok: true, reason: "verified", status: 200, triedUrl: BASE_URL, detail: "Found your code in the X-Hirakumi-Verify header." };
const MISSING = { ok: false, reason: "missing", status: 404, triedUrl: BASE_URL, detail: "Your API answered 404 without an X-Hirakumi-Verify header." };
const MISSING_REDIRECT = { ok: false, reason: "missing", status: 301, triedUrl: BASE_URL, detail: "Your server answered 301, but without the X-Hirakumi-Verify header." };
const MISSING_NO_STATUS = { ok: false, reason: "missing", triedUrl: BASE_URL, detail: "No X-Hirakumi-Verify header." };
const MISMATCH = { ok: false, reason: "mismatch", status: 200, triedUrl: BASE_URL, detail: "Found X-Hirakumi-Verify, but its value does not match this API's code." };
const TIMEOUT = { ok: false, reason: "timeout", triedUrl: BASE_URL, detail: "Your API took longer than 10 s to answer." };
const BAD_URL = { ok: false, reason: "bad_url", triedUrl: BASE_URL, detail: "The base URL contains your code. Use a base URL without it." };

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

const panel = (passed = false, platforms?: Promise<PlatformHint[]>) =>
  <OwnershipPanel apiId="api_1" baseUrl={BASE_URL} code={CODE} initiallyPassed={passed} platforms={platforms} />;
const checkCalls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter((c) => String(c[0]).endsWith("/ownership/spec-check")).length;

afterEach(() => {
  delete window.cardano;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setVisibility("visible");
  nav.push.mockReset();
});

describe("OwnershipPanel: what, where, why", () => {
  it("shows the header, the base URL it must be on, why, and a curl check, with no file", () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    render(panel());
    expect(screen.getByText(BASE_URL)).toBeInTheDocument();
    expect(screen.getByText(/^So nobody can sell an API they don't own\./)).toBeInTheDocument();
    expect(screen.getByText(`X-Hirakumi-Verify: ${CODE}`)).toBeInTheDocument();
    expect(screen.getByText(/Any status is fine, a 404 page counts\. The code proves the folder of this URL/)).toBeInTheDocument();
    expect(screen.getByText(`curl -s -o /dev/null -D - '${BASE_URL}' | grep -i x-hirakumi-verify`)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/hirakumi-verify\.json|OpenAPI file/);
    expect(document.body.textContent).not.toMatch(/[–—]/);
  });

  it("with no hint from the server, lists every recipe as a tab, none picked, and asks", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    const user = userEvent.setup();
    render(panel(false, Promise.resolve([])));
    expect(await screen.findByText("Pick where your API runs.")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Express", "FastAPI", "Flask", "Next.js", "nginx", "vercel.json", "Netlify _headers", "Cloudflare", "Go", "Any server"]);
    for (const t of screen.getAllByRole("tab")) expect(t).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByRole("tabpanel")).toBeNull();
    // The first tab is the one keyboard users land on.
    expect(screen.getByRole("tab", { name: "Express" })).toHaveAttribute("tabindex", "0");
    await user.click(screen.getByRole("tab", { name: "Express" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(`res.set("X-Hirakumi-Verify", "${CODE}");`);
    await user.click(screen.getByRole("tab", { name: "nginx" }));
    expect(screen.getByRole("tab", { name: "nginx" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent(`add_header X-Hirakumi-Verify "${CODE}" always;`);
    expect(within(screen.getByRole("tabpanel")).getByText(/sudo nginx -t && sudo systemctl reload nginx/)).toBeInTheDocument();
  });

  it("gives every recipe numbered steps that say where to paste it and what to do after", () => {
    for (const x of headerSnippets(CODE, BASE_URL)) {
      expect(x.steps.length, x.id).toBeGreaterThanOrEqual(2);
      expect(x.steps.join(" "), x.id).not.toMatch(/[–—]/);
    }
    const by = Object.fromEntries(headerSnippets(CODE, BASE_URL).map((x) => [x.id, x]));
    expect(by.express.steps[1]).toContain("const app = express()");
    expect(by.fastapi.text).toContain("from fastapi import FastAPI, Request");
    expect(by.flask.text).toContain("from flask import Flask");
    expect(by.go.text).toContain("hirakumiVerify(mux)");
    expect(by.other.steps[1]).toContain(BASE_URL);
    expect(by.other.text).toBe(`X-Hirakumi-Verify: ${CODE}`);
  });

  it("shows the optional key section between adding the code and signing", () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    const { container } = render(<OwnershipPanel apiId="api_1" baseUrl={BASE_URL} code={CODE} initiallyPassed={false} beforeSigning={<p>Key section</p>} />);
    // The panel's own steps: the outer list's items, not the numbered steps inside each recipe.
    const items = Array.from(container.querySelectorAll<HTMLElement>(":scope > ol > li"));
    expect(items.map((li) => li.textContent?.includes("Key section"))).toEqual([false, true, false]);
    expect(within(items[2]).getByRole("heading", { name: "Sign with your wallet" })).toBeInTheDocument();
  });

  it("builds the snippets from the code and the base URL", () => {
    const by = Object.fromEntries(headerSnippets(CODE, BASE_URL).map((x) => [x.id, x.text]));
    expect(by.nginx).toContain(`add_header X-Hirakumi-Verify "${CODE}" always;`);
    expect(JSON.parse(by.vercel)).toEqual({ headers: [{ source: "/(.*)", headers: [{ key: "X-Hirakumi-Verify", value: CODE }] }] });
    expect(by.netlify).toBe(`/*\n  X-Hirakumi-Verify: ${CODE}`);
    expect(by.cloudflare).toContain("URI Path starts with /v1");
    expect(headerSnippets(CODE, "https://price.example.dev/").find((x) => x.id === "cloudflare")?.text).toContain("All incoming requests");
    expect(by.fastapi).toContain(`response.headers["X-Hirakumi-Verify"] = "${CODE}"`);
    expect(by.flask).toContain("@app.after_request");
    expect(by.nextjs).toContain(`headers: [{ key: "X-Hirakumi-Verify", value: "${CODE}" }]`);
    expect(by.go).toContain(`w.Header().Set("X-Hirakumi-Verify", "${CODE}")`);
    expect(curlCheck(BASE_URL)).toBe(`curl -s -o /dev/null -D - '${BASE_URL}' | grep -i x-hirakumi-verify`);
    for (const x of headerSnippets(CODE, BASE_URL)) expect(x.text).not.toMatch(/[–—]/);
  });

  it("builds a coding-agent prompt with the code, the base URL, the rules and the curl check", () => {
    const p = agentPrompt(CODE, BASE_URL);
    expect(p).toContain(`X-Hirakumi-Verify with the value ${CODE}`);
    expect(p).toContain(`every response at ${BASE_URL} and every path below it, errors included (401, 404, 500)`);
    expect(p).toContain("without redirecting somewhere else");
    expect(p).toContain("Keep the header in place, at least until Hirakumi confirms ownership.");
    expect(p).toContain("Change nothing else.");
    expect(p).not.toContain("likely runs on");
    const withPlatform = agentPrompt(CODE, BASE_URL, { name: "nginx", evidence: "server: nginx/1.25.3" });
    expect(withPlatform).toContain(`The server answers with "server: nginx/1.25.3", so it likely runs on nginx.`);
    expect(p.endsWith(curlCheck(BASE_URL))).toBe(true);
    expect(p).not.toMatch(/[–—]/);
    expect(claudeUrl(p)).toBe(`https://claude.ai/new?q=${encodeURIComponent(p)}`);
  });

  it("offers the prompt to copy or open in Claude, before the do-it-yourself recipes", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(panel());
    const card = screen.getByRole("region", { name: "Let your AI do it" });
    expect(card).toHaveTextContent("Paste it into your coding agent");
    expect(card).toHaveTextContent(`X-Hirakumi-Verify with the value ${CODE}`);
    const open = within(card).getByRole("link", { name: /^Open in Claude/ });
    expect(open).toHaveAttribute("href", claudeUrl(agentPrompt(CODE, BASE_URL)));
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    await user.click(within(card).getByRole("button", { name: "Copy prompt" }));
    expect(writeText).toHaveBeenCalledWith(agentPrompt(CODE, BASE_URL));
    expect(within(card).getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(card.compareDocumentPosition(screen.getByRole("tablist")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("quotes the URL in the curl check, so shell characters in the path stay part of it", () => {
    // The URL parser keeps & | $ ( ) ! ' as they are in a path, and a shell would act on each of them.
    expect(curlCheck("https://api.example.com/a&b|c$(id)")).toBe("curl -s -o /dev/null -D - 'https://api.example.com/a&b|c$(id)' | grep -i x-hirakumi-verify");
    expect(curlCheck("https://api.example.com/it's")).toBe("curl -s -o /dev/null -D - 'https://api.example.com/it'\\''s' | grep -i x-hirakumi-verify");
  });

  it("copies a snippet", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(panel());
    const copy = screen.getByRole("button", { name: "Copy header" });
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith(`X-Hirakumi-Verify: ${CODE}`);
    await vi.waitFor(() => expect(copy).toHaveTextContent("Copied"));
    await user.click(screen.getByRole("button", { name: "Copy curl command" }));
    expect(writeText).toHaveBeenLastCalledWith(curlCheck(BASE_URL));
    await user.click(screen.getByRole("tab", { name: "nginx" }));
    await user.click(screen.getByRole("button", { name: "Copy nginx snippet" }));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining(`add_header X-Hirakumi-Verify "${CODE}" always;`));
  });
});

describe("OwnershipPanel: picks the recipe from the server's headers", () => {
  const NGINX: PlatformHint[] = [{ id: "nginx", evidence: "server: nginx/1.25.3" }];

  it("preselects the recipe the headers point to, says why, and marks it detected", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    render(panel(false, Promise.resolve([{ id: "express", evidence: "x-powered-by: Express" }, { id: "cloudflare", evidence: "cf-ray: 8f1d2c" }])));
    const tab = await screen.findByRole("tab", { name: "Express (detected)" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Cloudflare (detected)" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "nginx" })).toBeInTheDocument();
    expect(screen.getByText("x-powered-by: Express")).toBeInTheDocument();
    expect(screen.getByText(/so we picked Express\. Not right\? Pick yours\./)).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveTextContent(`res.set("X-Hirakumi-Verify", "${CODE}");`);
  });

  it("says it is reading the headers until the hint arrives, then preselects", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    let resolve!: (h: PlatformHint[]) => void;
    render(panel(false, new Promise<PlatformHint[]>((r) => { resolve = r; })));
    expect(screen.getByText(/Reading your server's response headers/)).toBeInTheDocument();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    await act(async () => resolve(NGINX));
    expect(screen.getByRole("tab", { name: "nginx (detected)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent(`add_header X-Hirakumi-Verify "${CODE}" always;`);
  });

  it("keeps the seller's own pick when the hint arrives later", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    const user = userEvent.setup();
    let resolve!: (h: PlatformHint[]) => void;
    render(panel(false, new Promise<PlatformHint[]>((r) => { resolve = r; })));
    await user.click(screen.getByRole("tab", { name: "Flask" }));
    await act(async () => resolve(NGINX));
    expect(screen.getByRole("tab", { name: "Flask" })).toHaveAttribute("aria-selected", "true");
  });

  it("falls back to the list when the probe fails", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    render(panel(false, Promise.reject(new Error("boom"))));
    expect(await screen.findByText("Pick where your API runs.")).toBeInTheDocument();
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  it("puts the detected platform in the prompt and the Claude link", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    render(panel(false, Promise.resolve(NGINX)));
    await screen.findByRole("tab", { name: "nginx (detected)" });
    const expected = agentPrompt(CODE, BASE_URL, { name: "nginx", evidence: "server: nginx/1.25.3" });
    const card = screen.getByRole("region", { name: "Let your AI do it" });
    expect(card).toHaveTextContent("so it likely runs on nginx.");
    const href = within(card).getByRole("link", { name: /^Open in Claude/ }).getAttribute("href")!;
    expect(href).toBe(`https://claude.ai/new?q=${encodeURIComponent(expected)}`);
    expect(decodeURIComponent(new URL(href).searchParams.get("q")!)).toBe(expected);
    // The URL carries the public code and base URL, nothing else: no API id, no session.
    expect(href).not.toContain("api_1");
  });

  it("moves between tabs with the arrow keys, Home and End", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MISSING)));
    const user = userEvent.setup();
    render(panel(false, Promise.resolve(NGINX)));
    const nginx = await screen.findByRole("tab", { name: "nginx (detected)" });
    nginx.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "vercel.json" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "vercel.json" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Any server" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Express" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Any server" })).toHaveFocus();
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
    expect(await screen.findByText(/^Checking https:\/\/price\.example\.dev\/v1…/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(await screen.findByText(/^Last checked 4 s ago\./)).toBeInTheDocument();
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
    [MISSING, "Missing", "Your API answered 404, but without the X-Hirakumi-Verify header.", false, "Deploy the change if you haven't yet."],
    [MISSING_NO_STATUS, "Missing", "Your API answered, but without the X-Hirakumi-Verify header.", false, "A CDN or proxy in front of your API must pass the header on."],
    // A platform redirect (/v1 to /v1/) runs before the seller's code, so say what to do about it.
    [MISSING_REDIRECT, "Missing", "Your API answered 301, a redirect, without the X-Hirakumi-Verify header. We only follow a redirect that adds a slash at the end of this URL. Add the header to the redirect too, or answer at this exact URL without redirecting.", false, "Run the curl command above."],
    [MISMATCH, "Wrong value", "We found X-Hirakumi-Verify, but the code doesn't match this API's code.", false, "Copy the header again from the top of this step."],
    [TIMEOUT, "Unreachable", "We couldn't reach your API at this URL.", true, "Make sure this URL answers over https from the public internet"],
    [BAD_URL, "Can't check", "We can't check this base URL.", true, "Fix the base URL in your API's setup"],
  ])("%#: %s", async (result, tag, headline, showsDetail, next) => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(result)));
    render(panel());
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(tag)).toBeInTheDocument();
    expect(alert).toHaveTextContent(headline);
    if (showsDetail) expect(alert).toHaveTextContent(result.detail);
    else expect(alert).not.toHaveTextContent(result.detail);
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
    expect(screen.getByText(/^Checking https:\/\/price\.example\.dev\/v1…/)).toBeInTheDocument();
    await act(async () => answer(jsonResponse(PASS)));
    const found = await screen.findByText("Found your code.");
    expect(found.parentElement).toHaveTextContent("Sign with your wallet below to finish.");
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

  it("a header pass that expired while the page was open is checked again, then signing goes on", async () => {
    installWallet();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PASS))
      .mockResolvedValueOnce(jsonResponse({ error: "Check your X-Hirakumi-Verify header first." }, 409))
      .mockResolvedValueOnce(jsonResponse(PASS))
      .mockResolvedValueOnce(jsonResponse({ challengeId: "ch_2", message: "Hirakumi ownership\napi: api_1" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ownership_verified" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(panel());
    expect(await screen.findByText("Found your code.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign with eternl" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/review"));
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "/api/apis/api_1/ownership/spec-check", "/api/apis/api_1/ownership/wallet-challenge",
      "/api/apis/api_1/ownership/spec-check", "/api/apis/api_1/ownership/wallet-challenge", "/api/apis/api_1/ownership/verify",
    ]);
  });

  it("an expired pass whose header is gone sends the seller back to step 1, not a dead end", async () => {
    installWallet();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PASS))
      .mockResolvedValueOnce(jsonResponse({ error: "Check your X-Hirakumi-Verify header first." }, 409))
      .mockResolvedValue(jsonResponse(MISSING));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(panel());
    expect(await screen.findByText("Found your code.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign with eternl" }));
    expect(await screen.findByText(/no longer sends your code/)).toBeInTheDocument();
    const step1 = screen.getByRole("listitem", { name: "Add your code" });
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
