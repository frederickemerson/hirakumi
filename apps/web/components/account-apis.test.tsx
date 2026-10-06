// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountApi } from "@/lib/account";
import { jsonResponse } from "@/test/http";
import { AccountApis } from "./account-apis";
import { Toaster } from "./toast";

function api(over: Partial<AccountApi>): AccountApi {
  return {
    id: "api_1", name: "Price API", state: "live", health: "healthy", healthCheckedAt: "2026-10-06T10:00:00.000Z",
    createdAt: "2026-10-01T10:00:00.000Z", paidCallsDay: 0, passDay: 0, failDay: 0, receivedMicros: "0",
    badge: { tone: "live", label: "Live", detail: null },
    deleteBlocker: "This API is on the Masumi registry. Retire it instead.",
    ...over,
  };
}

const live = api({ id: "api_live", name: "Price API", paidCallsDay: 4, passDay: 3, failDay: 1, receivedMicros: "4850000" });
const draft = api({
  id: "api_draft", name: "Weather API", state: "described", healthCheckedAt: null, receivedMicros: "0",
  badge: { tone: "progress", label: "In progress", detail: "Step 3 of 7: Choose endpoints. Your turn." }, deleteBlocker: null,
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const f = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

const row = (name: string) => screen.getByRole("listitem", { name });

describe("AccountApis", () => {
  it("shows totals and every API with its badge, stats and the actions it allows", () => {
    render(<AccountApis initial={[live, draft]} />);
    const totals = screen.getByRole("list", { name: "Totals" });
    expect(within(totals).getByText("Live APIs").nextSibling).toHaveTextContent("1");
    expect(within(totals).getByText("Paid calls, 24 h").nextSibling).toHaveTextContent("4");
    expect(within(totals).getByText("Total received").nextSibling).toHaveTextContent("4.85 tUSDM");

    const l = row("Price API");
    expect(within(l).getByText("Live")).toBeInTheDocument();
    expect(within(l).getByText("75%")).toBeInTheDocument();
    expect(within(l).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/apis/api_live");
    expect(within(l).getByRole("link", { name: "Try it live" })).toHaveAttribute("href", "/p/api_live/try");
    expect(within(l).getByRole("button", { name: "Retire" })).toBeInTheDocument();
    expect(within(l).queryByRole("button", { name: "Delete" })).toBeNull();

    const d = row("Weather API");
    expect(within(d).getByText("In progress")).toBeInTheDocument();
    expect(within(d).getByText("Step 3 of 7: Choose endpoints. Your turn.")).toBeInTheDocument();
    expect(within(d).queryByRole("link", { name: "Try it live" })).toBeNull();
    expect(within(d).queryByRole("button", { name: "Retire" })).toBeNull();
    expect(within(d).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("deletes after the name is typed, removes the row, updates totals and toasts", async () => {
    const user = userEvent.setup();
    const f = stubFetch(() => jsonResponse({ deleted: "api_draft", name: "Weather API" }));
    render(<><AccountApis initial={[live, draft]} /><Toaster /></>);
    await user.click(within(row("Weather API")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Weather API?" });
    await user.type(within(dialog).getByLabelText("Type Weather API to confirm"), "Weather API");
    await user.click(within(dialog).getByRole("button", { name: "Delete API" }));
    expect(f).toHaveBeenCalledWith("/api/apis/api_draft", expect.objectContaining({ method: "DELETE" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Weather API" })).toBeNull());
    expect(await screen.findByText("Deleted Weather API")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Price API" })).toBeInTheDocument();
  });

  it("retires a live API after a lighter confirmation and drops it from the live count", async () => {
    const user = userEvent.setup();
    const f = stubFetch(() => jsonResponse({ state: "retired" }));
    render(<><AccountApis initial={[live, draft]} /><Toaster /></>);
    await user.click(within(row("Price API")).getByRole("button", { name: "Retire" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Retire Price API?" });
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Retire API" }));
    expect(f).toHaveBeenCalledWith("/api/apis/api_live/retire", expect.objectContaining({ method: "POST" }));
    await waitFor(() => expect(within(row("Price API")).getByText("Retired")).toBeInTheDocument());
    expect(within(row("Price API")).queryByRole("link", { name: "Try it live" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Totals" })).getByText("Live APIs").nextSibling).toHaveTextContent("0");
    expect(await screen.findByText("Retired Price API")).toBeInTheDocument();
  });

  it("keeps the row and shows the reason when the server refuses", async () => {
    const user = userEvent.setup();
    stubFetch(() => jsonResponse({ error: "This API reached the Masumi registry, so its records stay." }, 409));
    render(<AccountApis initial={[draft]} />);
    await user.click(within(row("Weather API")).getByRole("button", { name: "Delete" }));
    await user.type(await screen.findByLabelText("Type Weather API to confirm"), "Weather API");
    await user.click(screen.getByRole("button", { name: "Delete API" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This API reached the Masumi registry, so its records stay.");
    // The open modal hides the page from assistive tech, so look past that.
    expect(screen.getByRole("listitem", { name: "Weather API", hidden: true })).toBeInTheDocument();
  });

  it("says so when there are no APIs", () => {
    render(<AccountApis initial={[]} />);
    expect(screen.getByText("You haven't listed an API yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add an API" })).toHaveAttribute("href", "/apis/new");
  });
});
