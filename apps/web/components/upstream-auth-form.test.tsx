// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { describeCheck, describePart, describeSetting, UpstreamAuthForm, withPrefix } from "./upstream-auth-form";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

const KEY = "sk_live_0123456789abcdefWXYZ";

afterEach(() => vi.unstubAllGlobals());

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
const mockFetch = (reply: (url: string, init: RequestInit) => Response): FetchMock => vi.fn(async (url: string, init: RequestInit) => reply(url, init));

function sentBody(fetchMock: FetchMock, n = 0) {
  return JSON.parse(String(fetchMock.mock.calls[n][1].body)) as Record<string, unknown>;
}

describe("UpstreamAuthForm", () => {
  it("says plainly where the key goes and that it is never shown again", () => {
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} />);
    expect(screen.getByRole("heading", { name: "Does your API need a key?" })).toBeInTheDocument();
    expect(screen.getByText(/encrypted so only the Hirakumi gateway can read it/)).toBeInTheDocument();
    expect(screen.getByText(/sent only to this API's own address, and it is never shown again/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Key")).toBeNull();
    expect(screen.getByRole("button", { name: "Add a key" })).toBeInTheDocument();
  });

  it("adds a header key, clears the field and shows only the name and the last 4 characters", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ in: "header", name: "X-API-Key", hint: "WXYZ" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} />);
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    expect(screen.getByRole("radio", { name: "Header" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Key")).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("Header name"), "X-API-Key");
    await user.type(screen.getByLabelText("Key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/apis/api_1/upstream-auth");
    expect(sentBody(fetchMock)).toEqual({ in: "header", name: "X-API-Key", value: KEY });
    expect(await screen.findByTestId("upstream-auth-current")).toHaveTextContent("X-API-Key in header, ending in WXYZ");
    expect(screen.queryByLabelText("Key")).toBeNull();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("prefills from the OpenAPI file and adds the Bearer prefix when it is left out", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ in: "header", name: "Authorization", hint: "WXYZ" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={{ in: "header", name: "Authorization", prefix: "Bearer " }} />);
    expect(screen.getByLabelText("Header name")).toHaveValue("Authorization");
    expect(screen.getByLabelText("Key")).toHaveAttribute("placeholder", "Bearer ...");
    expect(screen.getByText(/asks for a key in the header Authorization/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(sentBody(fetchMock).value).toBe(`Bearer ${KEY}`);
  });

  it("uses a query parameter when chosen", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ in: "query", name: "api_key", hint: "WXYZ" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} />);
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    // Header by default, with no warning; a query parameter warns that the address can leak.
    expect(screen.getByRole("radio", { name: "Header" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("query-key-warning")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Query parameter" }));
    expect(screen.getByTestId("query-key-warning")).toHaveTextContent(
      "A key in the address can leak in logs and error messages. Use a header if your API accepts one.",
    );
    await user.type(screen.getByLabelText("Query parameter name"), "api_key");
    await user.type(screen.getByLabelText("Key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(sentBody(fetchMock)).toEqual({ in: "query", name: "api_key", value: KEY });
    expect(await screen.findByTestId("upstream-auth-current")).toHaveTextContent("api_key in query, ending in WXYZ");
  });

  it("replaces and removes the current key", async () => {
    const fetchMock = mockFetch((_url, init) =>
      init.method === "DELETE" ? jsonResponse({ removed: true }) : jsonResponse({ in: "header", name: "X-API-Key", hint: "ABCD" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={{ in: "header", name: "X-API-Key", hint: "WXYZ" }} hint={null} />);
    expect(screen.getByTestId("upstream-auth-current")).toHaveTextContent("X-API-Key in header, ending in WXYZ");
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByLabelText("Header name")).toHaveValue("X-API-Key");
    expect(screen.getByLabelText("Key")).toHaveValue("");
    await user.type(screen.getByLabelText("Key"), "another-key-1234567890-ABCD");
    await user.click(screen.getByRole("button", { name: "Save the new key" }));
    expect(await screen.findByTestId("upstream-auth-current")).toHaveTextContent("ending in ABCD");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(fetchMock.mock.calls[1]).toEqual(["/api/apis/api_1/upstream-auth", expect.objectContaining({ method: "DELETE" })]);
    expect(await screen.findByText("Key removed. Calls to your API go without a key.")).toBeInTheDocument();
    expect(screen.queryByTestId("upstream-auth-current")).toBeNull();
  });

  it("shows the server's reason when a key is refused, and keeps what was typed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Hirakumi sets the Host header itself. Use the header your API reads the key from." }, 400)));
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} />);
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    await user.type(screen.getByLabelText("Header name"), "Host");
    await user.type(screen.getByLabelText("Key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText(/Hirakumi sets the Host header itself/)).toBeInTheDocument();
    expect(screen.getByLabelText("Key")).toHaveValue(KEY);
  });
});

describe("UpstreamAuthForm checks the key before saving", () => {
  const refusedCheck = { opened: true, class: "refused", status: 401, op: "GET /quotes" };

  it("shows a refused key with Save anyway, which sends the same key again with saveAnyway", async () => {
    const fetchMock = mockFetch((_url, init) => (JSON.parse(String(init.body)) as { saveAnyway?: boolean }).saveAnyway
      ? jsonResponse({ in: "header", name: "X-API-Key", hint: "WXYZ", check: refusedCheck })
      : jsonResponse({ code: "KEY_REFUSED", error: "Your API refused the key.", check: refusedCheck }, 409));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} />);
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    await user.type(screen.getByLabelText("Header name"), "X-API-Key");
    await user.type(screen.getByLabelText("Key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("Your API answered 401 with this key: typo or revoked key.")).toBeInTheDocument();
    expect(screen.getByLabelText("Key")).toHaveValue(KEY);
    await user.click(screen.getByRole("button", { name: "Save anyway" }));
    expect(sentBody(fetchMock, 1)).toEqual({ in: "header", name: "X-API-Key", value: KEY, saveAnyway: true });
    expect(await screen.findByTestId("upstream-auth-current")).toHaveTextContent("X-API-Key in header, ending in WXYZ");
    expect(screen.queryByRole("button", { name: "Save anyway" })).toBeNull();
  });

  it("sends a Bearer key as a preset and shows the check and the warnings that came back", async () => {
    const fetchMock = mockFetch(() => jsonResponse({
      in: "header", name: "Authorization", hint: "WXYZ",
      check: { opened: true, class: "ok", status: 200, op: "GET /quotes" }, warnings: ["This key expires in 2 days."],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} />);
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    await user.selectOptions(screen.getByLabelText("How does your API take its key?"), "bearer");
    expect(screen.getByLabelText("Word before the key")).toHaveValue("Bearer");
    await user.type(screen.getByLabelText("Key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(sentBody(fetchMock)).toEqual({ preset: "bearer", fields: { key: KEY, scheme: "Bearer" } });
    expect(await screen.findByText("Accepted (HTTP 200 on GET /quotes, promise met).")).toBeInTheDocument();
    expect(screen.getByText("This key expires in 2 days.")).toBeInTheDocument();
  });

  it("offers keys in several places only when they can be saved", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} />);
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    expect(screen.queryByRole("option", { name: "Two headers" })).toBeNull();
    unmount();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} v3 egressIps={["203.0.113.7"]} />);
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    expect(screen.getByRole("option", { name: "Two headers" })).toBeInTheDocument();
    expect(screen.getByTestId("egress-ips")).toHaveTextContent("allow 203.0.113.7");
  });

  it("sends a key and fixed text as rows, and says fixed text isn't withheld", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ parts: [{ in: "header", name: "Authorization", hint: "WXYZ" }, { in: "header", name: "Notion-Version", hint: "" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} v3 />);
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    await user.selectOptions(screen.getByLabelText("How does your API take its key?"), "keyPlusFixed");
    expect(screen.getByTestId("fixed-text-note")).toHaveTextContent("Fixed text isn't withheld if your API repeats it.");
    await user.type(screen.getByLabelText("Part 1 name"), "Authorization");
    await user.type(screen.getByLabelText("Part 1 value"), `Bearer ${KEY}`);
    await user.type(screen.getByLabelText("Part 2 name"), "Notion-Version");
    await user.type(screen.getByLabelText("Part 2 value"), "2022-06-28");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(sentBody(fetchMock)).toEqual({ preset: "keyPlusFixed", fields: { rows: [
      { in: "header", name: "Authorization", value: `Bearer ${KEY}`, fixed: false },
      { in: "header", name: "Notion-Version", value: "2022-06-28", fixed: true },
    ] } });
    expect(await screen.findByTestId("upstream-auth-current")).toHaveTextContent("Header Authorization ••••WXYZ");
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("prefills the matching preset when the OpenAPI file asks for two keys at once", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ parts: [{ in: "header", name: "apikey", hint: "WXYZ" }, { in: "header", name: "Authorization", hint: "WXYZ" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const hint = {
      in: "header" as const, name: "apikey",
      parts: [{ in: "header" as const, name: "apikey" }, { in: "header" as const, name: "Authorization", prefix: "Bearer " }],
    };
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={hint} v3 />);
    expect(screen.getByTestId("auth-hint")).toHaveTextContent(
      "Your API description asks for a key in several parts at once: the header apikey and the header Authorization (Bearer).",
    );
    expect(screen.getByLabelText("How does your API take its key?")).toHaveValue("twoHeaders");
    expect(screen.getByLabelText("Part 1 name")).toHaveValue("apikey");
    expect(screen.getByLabelText("Part 2 name")).toHaveValue("Authorization");
    expect(screen.getByLabelText("Part 1 value")).toHaveValue("");
    await user.type(screen.getByLabelText("Part 1 value"), KEY);
    await user.type(screen.getByLabelText("Part 2 value"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(sentBody(fetchMock)).toEqual({ preset: "twoHeaders", fields: { rows: [
      { in: "header", name: "apikey", value: KEY, fixed: false },
      { in: "header", name: "Authorization", value: KEY, fixed: false, scheme: "Bearer" },
    ] } });
  });

  it("without UPSTREAM_AUTH_V3 a key in several parts prefills only its first part", () => {
    const hint = { in: "header" as const, name: "apikey", parts: [{ in: "header" as const, name: "apikey" }, { in: "query" as const, name: "app" }] };
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={hint} />);
    expect(screen.getByLabelText("How does your API take its key?")).toHaveValue("single");
    expect(screen.getByLabelText("Header name")).toHaveValue("apikey");
  });

  it("lists a stored key's parts read-only, and Replace opens an empty preset form", async () => {
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" hint={null} v3
      initial={{ parts: [{ in: "header", name: "apikey", hint: "WXYZ" }, { in: "query", name: "app_id", hint: "" }] }} />);
    const list = screen.getByTestId("upstream-auth-current");
    expect(list).toHaveTextContent("Header apikey ••••WXYZ");
    expect(list).toHaveTextContent("Query parameter app_id");
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByLabelText("How does your API take its key?")).toHaveValue("headerPlusQuery");
    expect(screen.getByLabelText("Part 1 name")).toHaveValue("");
    expect(screen.getByLabelText("Part 1 value")).toHaveValue("");
    expect(screen.getByLabelText("Part 2 value")).toHaveValue("");
  });

  it("marks fixed text in a stored key, and Replace reopens it as a key and fixed text", async () => {
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" hint={null} v3
      initial={{ parts: [{ in: "header", name: "Notion-Version", hint: "", fixed: true }, { in: "header", name: "X-API-Key", hint: "WXYZ" }] }} />);
    expect(screen.getByTestId("upstream-auth-current")).toHaveTextContent("Header Notion-Version (fixed)");
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByLabelText("How does your API take its key?")).toHaveValue("keyPlusFixed");
    expect(screen.getByLabelText("Part 1")).toHaveValue("fixed");
    expect(screen.getByLabelText("Part 2")).toHaveValue("secret");
    expect(screen.getByLabelText("Part 1 value")).toHaveValue("");
  });

  it("offers HTTP Basic with a password only when it can be saved", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ in: "header", name: "Authorization", hint: "" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { unmount } = render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} />);
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    await user.selectOptions(screen.getByLabelText("How does your API take its key?"), "basic");
    expect(screen.getByRole("option", { name: "HTTP Basic (the key as the user name)" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByTestId("basic-note")).toHaveTextContent("can't be saved here yet");
    await user.type(screen.getByLabelText("Key (sent as the user name)"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(sentBody(fetchMock)).toEqual({ preset: "basic", fields: { username: KEY, password: "" } });
    unmount();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} v3 />);
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    await user.selectOptions(screen.getByLabelText("How does your API take its key?"), "basic");
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("checks a stored key on request", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ check: { opened: true, class: "forbidden", status: 403, op: "GET /quotes" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={{ in: "header", name: "X-API-Key", hint: "WXYZ" }} hint={null} checkable egressIps={["203.0.113.7"]} />);
    await user.click(screen.getByRole("button", { name: "Check key now" }));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/apis/api_1/upstream-auth/check");
    expect(await screen.findByText(/Access blocked \(403\).*203\.0\.113\.7, shared by all Hirakumi sellers/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save anyway" })).toBeNull();
  });

  it("warns when the API's address looks like it holds a key", () => {
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={null} keyInAddress />);
    expect(screen.getByTestId("address-key-warning")).toHaveTextContent("looks like a key");
  });
});

describe("UpstreamAuthForm after failed test calls", () => {
  it("says the test calls run again, and refreshes the page after saving or removing the key", async () => {
    refresh.mockClear();
    const fetchMock = mockFetch((_url, init) => jsonResponse(init.method === "DELETE" ? { removed: true } : { in: "header", name: "X-API-Key", hint: "WXYZ" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={{ in: "header", name: "X-API-Key" }} retriesTests />);
    expect(screen.getByText("When you save or remove the key, the test calls run again.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("Key saved. The test calls run again now.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Key removed. The test calls run again now.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh elsewhere", async () => {
    refresh.mockClear();
    vi.stubGlobal("fetch", mockFetch(() => jsonResponse({ in: "header", name: "X-API-Key", hint: "WXYZ" })));
    const user = userEvent.setup();
    render(<UpstreamAuthForm apiId="api_1" initial={null} hint={{ in: "header", name: "X-API-Key" }} />);
    await user.type(screen.getByLabelText("Key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("Key saved. Hirakumi sends it with every call to your API.")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("shows the gateway's notice about the stored key", () => {
    const notice = "The API's address changed since the key was saved. Save the key again.";
    render(<UpstreamAuthForm apiId="api_1" initial={{ in: "header", name: "X-API-Key", hint: "WXYZ" }} hint={null} notice={notice} />);
    expect(screen.getByRole("alert")).toHaveTextContent(notice);
  });

  it("describes parts and checks in the seller's words", () => {
    expect(describePart({ in: "header", name: "Notion-Version", hint: "", fixed: true })).toBe("Header Notion-Version (fixed)");
    expect(describeCheck({ opened: true, class: "accepted_unverified", status: 200 }).text)
      .toBe("Your API answered 200 with this key; the promise isn't built yet, so we couldn't check the answer.");
    expect(describeCheck({ opened: true, class: "unchecked", why: "not_proven" }).text)
      .toBe("Saved sealed. Not checked yet: we check it once your address is proven.");
    // Follow-up A: a good answer from an endpoint that doesn't need the key is never "Accepted".
    const notProtected = describeCheck({ opened: true, class: "unchecked", why: "not_protected", status: 200, op: "getPrice" });
    expect(notProtected).toEqual({
      tone: "note",
      text: "Not checked: your API answered 200 on getPrice, but your OpenAPI file doesn't say that endpoint needs the key, so any key would get that answer.",
    });
    expect(describeCheck({ opened: true, class: "unclear", status: 200, reasons: ["price is missing"] }).text)
      .toBe("Answered 200 but the promise failed: price is missing");
    // A compressed answer has no status, only the gateway's reason: the seller still sees it.
    expect(describeCheck({ opened: true, class: "unclear", reasons: ["The answer was compressed."] }).text)
      .toBe("Couldn't tell: The answer was compressed.");
    expect(describeCheck({ opened: true, class: "unclear" }).text).toBe("Couldn't tell.");
    expect(describeCheck({ opened: true, class: "forbidden", status: 403 }).text).toBe("Access blocked (403): the key's permissions, an IP allowlist or a firewall.");
    expect(describeCheck({ opened: false, class: "unchecked" }).text)
      .toBe("The gateway couldn't read this key, so it isn't checked. Try again later, or save the key again.");
  });

  it("describes a setting without a hint for short keys", () => {
    expect(describeSetting({ in: "query", name: "key", hint: "" })).toBe("key in query");
  });
  it("adds a prefix only when missing", () => {
    expect(withPrefix(" abc ", "Bearer ")).toBe("Bearer abc");
    expect(withPrefix("bearer abc", "Bearer ")).toBe("bearer abc");
    expect(withPrefix("abc", undefined)).toBe("abc");
  });
});
