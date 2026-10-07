// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { SetupForm } from "./setup-form";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

afterEach(() => {
  vi.unstubAllGlobals();
  nav.push.mockReset();
});

describe("SetupForm", () => {
  it("submits the link and opens the Endpoints step", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ apiId: "api_1", state: "intake", created: true }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SetupForm initialUrl="" />);
    await user.type(screen.getByLabelText("OpenAPI link"), "https://price.example.dev/openapi.json");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/endpoints"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ openapiUrl: "https://price.example.dev/openapi.json", name: "" });
  });

  it("says an API already live is already monetized, and links to it instead of jumping there", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ apiId: "api_1", state: "live", name: "Live Crypto Prices", created: false }, 200)));
    const user = userEvent.setup();
    render(<SetupForm initialUrl="" />);
    await user.type(screen.getByLabelText("OpenAPI link"), "https://price.example.dev/openapi.json");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const notice = await screen.findByTestId("already-listed");
    expect(notice).toHaveTextContent("This API is already monetized on Hirakumi.");
    expect(screen.getByRole("link", { name: "Open Live Crypto Prices" })).toHaveAttribute("href", "/apis/api_1/overview");
    expect(screen.getByRole("link", { name: "Its public page" })).toHaveAttribute("href", "/p/api_1");
    expect(nav.push).not.toHaveBeenCalled();
    expect(notice.textContent).not.toMatch(/[–—]/);
  });

  it("says an API still being listed was already started, and continues it on request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ apiId: "api_2", state: "endpoints_confirmed", name: "FX", created: false }, 200)));
    const user = userEvent.setup();
    render(<SetupForm initialUrl="" />);
    await user.type(screen.getByLabelText("OpenAPI link"), "https://fx.example.dev/openapi.json");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("You already started listing this API.")).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue listing FX" }));
    expect(nav.push).toHaveBeenCalledWith("/apis/api_2/endpoints");
  });

  it("shows the server's error next to the form", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "The link must start with https://" }, 400)));
    render(<SetupForm initialUrl="http://price.example.dev" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The link must start with https://");
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("SetupForm without an OpenAPI file", () => {
  it("offers only the OpenAPI link while listing from example requests is off", () => {
    render(<SetupForm initialUrl="" />);
    expect(screen.queryByRole("radio", { name: "I don't" })).toBeNull();
    expect(screen.queryByLabelText("Base URL")).toBeNull();
    expect(screen.getByLabelText("OpenAPI link")).toBeInTheDocument();
  });

  it("sends the base URL and example requests", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ apiId: "api_2", state: "intake", created: true }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SetupForm initialUrl="" samples />);
    await user.click(screen.getByRole("radio", { name: "I don't" }));
    expect(screen.queryByLabelText("OpenAPI link")).toBeNull();
    await user.type(screen.getByLabelText("Base URL"), "https://api.example.com/v1");
    await user.type(screen.getByLabelText("Example requests"), "GET /price?symbol=ADA");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_2/endpoints"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      mode: "samples", baseUrl: "https://api.example.com/v1", samples: "GET /price?symbol=ADA", name: "",
    });
  });
});

describe("SetupForm when an example request may hold a key", () => {
  it("shows each warning and waits for the seller before opening the Endpoints step", async () => {
    const warning = 'Line 2: "appid" may be your API\'s key. If it is, remove it from the example requests: buyers see every example value.';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ apiId: "api_3", state: "intake", created: true, keyWarnings: [warning] }, 201)));
    const user = userEvent.setup();
    render(<SetupForm initialUrl="" samples />);
    await user.click(screen.getByRole("radio", { name: "I don't" }));
    await user.type(screen.getByLabelText("Base URL"), "https://api.example.com/v1");
    await user.type(screen.getByLabelText("Example requests"), "GET /price?symbol=ADA");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(warning)).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue to endpoints" }));
    expect(nav.push).toHaveBeenCalledWith("/apis/api_3/endpoints");
  });
});

describe("SetupForm with a Sokosumi setup token (review I5)", () => {
  it("sends the setup token with the OpenAPI link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ apiId: "api_1", state: "intake", created: true }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupForm initialUrl="https://price.example.dev/openapi.json" setupToken="tok_x" />);
    await userEvent.click(screen.getByRole("button"));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({ openapiUrl: "https://price.example.dev/openapi.json", setupToken: "tok_x" });
  });
});
