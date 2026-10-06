// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { describeSetting, UpstreamAuthForm, withPrefix } from "./upstream-auth-form";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

const KEY = "sk_live_0123456789abcdefWXYZ";

afterEach(() => vi.unstubAllGlobals());

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
const mockFetch = (reply: (url: string, init: RequestInit) => Response): FetchMock => vi.fn(async (url: string, init: RequestInit) => reply(url, init));

function sentBody(fetchMock: FetchMock, n = 0) {
  return JSON.parse(String(fetchMock.mock.calls[n][1].body)) as Record<string, string>;
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

  it("describes a setting without a hint for short keys", () => {
    expect(describeSetting({ in: "query", name: "key", hint: "" })).toBe("key in query");
  });
  it("adds a prefix only when missing", () => {
    expect(withPrefix(" abc ", "Bearer ")).toBe("Bearer abc");
    expect(withPrefix("bearer abc", "Bearer ")).toBe("bearer abc");
    expect(withPrefix("abc", undefined)).toBe("abc");
  });
});
