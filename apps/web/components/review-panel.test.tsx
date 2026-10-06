// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuleView } from "@/lib/types";
import { jsonResponse } from "@/test/http";
import { ReviewPanel } from "./review-panel";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const promises: RuleView[] = [{
  operationId: "op_1", opId: "getPrice", method: "GET", path: "/price", version: 1, hash: "sha256:abc",
  definition: { version: 1, schema: { properties: { last_updated: { type: "string", maxAgeSeconds: 300 } } } },
  plainEnglish: 'The response has a number "price" and a "last_updated" time under 5 minutes old.',
}];

afterEach(() => {
  vi.unstubAllGlobals();
  nav.push.mockReset();
  nav.refresh.mockReset();
});

describe("ReviewPanel", () => {
  it("shows the promise in plain English with the exact check underneath", () => {
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    expect(screen.getByText(promises[0].plainEnglish!)).toBeInTheDocument();
    expect(screen.getByText("Show the exact check (JSON)")).toBeInTheDocument();
    expect(screen.getByText(/"last_updated":/)).toBeInTheDocument(); // the JSON block, not the sentence
  });

  it("suggests 100 calls for 2 tUSDM and shows the per-call price", () => {
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    expect(screen.getByLabelText("Calls per pack")).toHaveValue("100");
    expect(screen.getByLabelText("Pack price (tUSDM)")).toHaveValue("2");
    expect(screen.getByText("About 0.02 tUSDM per call.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("saves the price as typed and refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ state: "priced" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    await user.clear(screen.getByLabelText("Pack price (tUSDM)"));
    await user.type(screen.getByLabelText("Pack price (tUSDM)"), "2.5");
    await user.click(screen.getByRole("button", { name: "Save price" }));
    await vi.waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ packCalls: "100", packPrice: "2.5", escrowPrice: "2" });
  });

  it("publishes when priced and opens the overview", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ state: "registering" })));
    render(<ReviewPanel apiId="api_1" state="priced" promises={promises}
      pack={{ id: "pk_1", calls: 100, priceMicros: "2000000", escrowPriceMicros: "2000000" }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Publish" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/overview"));
  });

  it("shows the server's error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "A pack must cost at least 1 tUSDM. Cardano can't move smaller token payments cheaply." }, 400)));
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save price" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A pack must cost at least 1 tUSDM.");
  });
});
