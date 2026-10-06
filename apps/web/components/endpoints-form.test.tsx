// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Operation } from "@/lib/types";
import { jsonResponse } from "@/test/http";
import { EndpointsForm } from "./endpoints-form";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const ops: Operation[] = [
  { id: "op_get", opId: "getPrice", method: "GET", path: "/price", description: "Latest price",
    sideEffectsLikely: false, sideEffectsConfirmedNone: false, enabled: false },
  { id: "op_post", opId: "refreshCache", method: "POST", path: "/admin/refresh", description: "Refreshes the cache",
    sideEffectsLikely: true, sideEffectsConfirmedNone: false, enabled: false },
];

afterEach(() => {
  vi.unstubAllGlobals();
  nav.push.mockReset();
});

describe("EndpointsForm", () => {
  it("starts with everything blocked and explains why it can't continue", () => {
    render(<EndpointsForm apiId="api_1" operations={ops} initialEscrowOpId={null} />);
    expect(screen.getByRole("button", { name: "Confirm endpoints" })).toBeDisabled();
    expect(screen.getByText("Choose at least one endpoint to sell.")).toBeInTheDocument();
    expect(screen.getByText("This might change data on your server.")).toBeInTheDocument();
  });

  it("sends the selection and opens the Ownership step", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ state: "endpoints_confirmed" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<EndpointsForm apiId="api_1" operations={ops} initialEscrowOpId={null} />);
    await user.click(screen.getByLabelText("Sell GET /price"));
    await user.click(screen.getByLabelText("Use GET /price for per-job hires"));
    await user.click(screen.getByRole("button", { name: "Confirm endpoints" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/ownership"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/apis/api_1/endpoints");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      enabledIds: ["op_get"], confirmedNoSideEffectIds: [], escrowOperationId: "op_get",
    });
  });

  it("asks for the no-side-effects tick before a POST endpoint can be sold", async () => {
    const user = userEvent.setup();
    render(<EndpointsForm apiId="api_1" operations={ops} initialEscrowOpId={null} />);
    await user.click(screen.getByLabelText("Sell POST /admin/refresh"));
    await user.click(screen.getByLabelText("Use POST /admin/refresh for per-job hires"));
    expect(screen.getByRole("button", { name: "Confirm endpoints" })).toBeDisabled();
    await user.click(screen.getByLabelText("POST /admin/refresh changes nothing on my server"));
    expect(screen.getByRole("button", { name: "Confirm endpoints" })).toBeEnabled();
  });

  it("shows the server's error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "Endpoints can't be changed at this stage. Reload the page." }, 409)));
    const user = userEvent.setup();
    render(<EndpointsForm apiId="api_1" operations={ops} initialEscrowOpId={null} />);
    await user.click(screen.getByLabelText("Sell GET /price"));
    await user.click(screen.getByLabelText("Use GET /price for per-job hires"));
    await user.click(screen.getByRole("button", { name: "Confirm endpoints" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Endpoints can't be changed at this stage.");
  });
});
