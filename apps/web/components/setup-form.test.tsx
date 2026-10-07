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

  it("shows the server's error next to the form", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "The link must start with https://" }, 400)));
    render(<SetupForm initialUrl="http://price.example.dev" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The link must start with https://");
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("SetupForm without an OpenAPI file", () => {
  it("sends the base URL and example requests", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ apiId: "api_2", state: "intake", created: true }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SetupForm initialUrl="" />);
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
