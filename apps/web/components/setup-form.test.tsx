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
