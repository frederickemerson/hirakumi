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
  statusOnly: false, requiredPhrases: [],
}];
const STATUS_ONLY_NOTICE = "This promise only checks the status. Add a phrase every good answer contains before you publish. Without a phrase, an error page sent with status 200 could count as a good answer.";
const statusOnly: RuleView = {
  ...promises[0], operationId: "op_2", path: "/quote", statusOnly: true,
  definition: { version: 1, contentType: "text/plain", schema: { type: "string", minLength: 1 } },
};

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

  it("says a text promise checks the answer as text; a JSON promise has no such line", () => {
    const csv: RuleView = { ...promises[0], operationId: "op_2", definition: { version: 1, contentType: "text/csv", schema: { type: "string", minLength: 1 } } };
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={[promises[0], csv]} pack={null} />);
    expect(screen.getAllByText(/checked as text/)).toHaveLength(1);
    expect(screen.getByText("Answers are CSV (text/csv), checked as text.")).toBeInTheDocument();
  });

  it("offers a phrase field only for a text promise; a status-only one needs it before publishing", () => {
    render(<ReviewPanel apiId="api_1" state="priced" promises={[promises[0], statusOnly]} pack={null} />);
    expect(screen.getAllByLabelText(/^Every good answer contains/)).toHaveLength(1);
    expect(screen.getByLabelText("Every good answer contains (required)")).toHaveValue("");
    expect(screen.getByTestId("status-only-notice")).toHaveTextContent(STATUS_ONLY_NOTICE);
    expect(screen.getByText("Type a word or label every good answer contains, like Price or Symbol. Capital letters don't matter.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish at this price" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save price" })).toBeEnabled();
    expect(screen.getByTestId("publish-needs-phrase")).toHaveTextContent(
      "Add a phrase every good answer contains for GET /quote before publishing. Without a phrase, an error page sent with status 200 could count as a good answer.",
    );
  });

  it("prefills QA's suggested phrase for a status-only promise and saves it as confirmed", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true, version: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ReviewPanel apiId="api_1" state="priced" promises={[statusOnly]} pack={null} suggestedPhrases={{ op_2: "Last price:" }} />);
    expect(screen.getByLabelText("Every good answer contains (required)")).toHaveValue("Last price:");
    expect(screen.getByText("We found this in every good test answer and not in the wrong one. Check it or change it.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add phrase" }));
    await vi.waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ operationId: "op_2", phrase: "Last price:" });
  });

  it("ignores a suggestion for a promise that already checks more than the status", () => {
    const csv: RuleView = { ...promises[0], operationId: "op_3", definition: { version: 1, contentType: "text/csv", schema: { type: "string", pattern: "^symbol,price" } } };
    render(<ReviewPanel apiId="api_1" state="priced" promises={[csv]} pack={null} suggestedPhrases={{ op_3: "symbol" }} />);
    expect(screen.getByLabelText("Every good answer contains (optional)")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Publish at this price" })).toBeEnabled();
    expect(screen.queryByTestId("publish-needs-phrase")).toBeNull();
  });

  it("saves a phrase for a text promise and refreshes; shows the phrases already required", async () => {
    const text: RuleView = {
      ...promises[0], operationId: "op_2", requiredPhrases: ["price:"],
      definition: { version: 1, contentType: "text/plain", schema: { type: "string", allOf: [{ pattern: "\\S" }, { pattern: "price:" }] } },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true, version: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ReviewPanel apiId="api_1" state="priced" promises={[text]} pack={null} />);
    expect(screen.queryByTestId("status-only-notice")).toBeNull();
    expect(screen.getByText('Every good answer contains: "price:"')).toBeInTheDocument();
    await user.type(screen.getByLabelText("Every good answer contains (optional)"), "BTC");
    await user.click(screen.getByRole("button", { name: "Add phrase" }));
    await vi.waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/apis/api_1/promise-phrase");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ operationId: "op_2", phrase: "BTC" });
  });

  it("suggests 100 calls for 2 tUSDM and shows the per-call price", () => {
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    expect(screen.getByLabelText("Calls per pack")).toHaveValue("100");
    expect(screen.getByLabelText("Pack price (tUSDM)")).toHaveValue("2");
    expect(screen.getByText("About 0.02 tUSDM per call.")).toBeInTheDocument();
    // One primary action; saving alone is secondary.
    expect(screen.getByRole("button", { name: "Publish at this price" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save price" })).toBeEnabled();
  });

  it("publishes in one click: saves the price as typed, then publishes, then opens the overview", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ state: "priced" }))
      .mockResolvedValueOnce(jsonResponse({ state: "registering" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    await user.clear(screen.getByLabelText("Calls per pack"));
    await user.type(screen.getByLabelText("Calls per pack"), "50");
    await user.click(screen.getByRole("button", { name: "Publish at this price" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/overview"));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/apis/api_1/pricing", "/api/apis/api_1/publish"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ packCalls: "50", packPrice: "2", escrowPrice: "2" });
  });

  it("does not publish when saving the price fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "A pack must cost at least 1 tUSDM. Cardano can't move smaller token payments cheaply." }, 400));
    vi.stubGlobal("fetch", fetchMock);
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Publish at this price" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A pack must cost at least 1 tUSDM.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(nav.push).not.toHaveBeenCalled();
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

  it("shows the server's error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "A pack must cost at least 1 tUSDM. Cardano can't move smaller token payments cheaply." }, 400)));
    render(<ReviewPanel apiId="api_1" state="rule_built" promises={promises} pack={null} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save price" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A pack must cost at least 1 tUSDM.");
  });
});
