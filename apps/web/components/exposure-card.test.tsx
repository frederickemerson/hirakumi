// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { checkedLabel, ExposureCard, KEY_FORM_ID } from "./exposure-card";

afterEach(() => vi.unstubAllGlobals());

describe("ExposureCard", () => {
  it("before any check, says what the check does and offers to run it", () => {
    render(<ExposureCard apiId="api_1" initial={null} />);
    expect(screen.getByRole("heading", { name: "Only buyers can call it" })).toBeInTheDocument();
    expect(screen.getByTestId("exposure-text")).toHaveTextContent(/calls each endpoint once without your key/);
    expect(screen.getByRole("button", { name: "Check now" })).toBeInTheDocument();
  });

  it("a stored open result says publishing waits and points to the key form", () => {
    render(<ExposureCard apiId="api_1" initial={{ exposure: "open", checkedAt: "2026-10-07T17:20:31.000Z" }} />);
    expect(screen.getByTestId("exposure-card")).toHaveAttribute("data-exposure", "open");
    expect(screen.getByTestId("exposure-text")).toHaveTextContent(
      "Anyone can call your API for free without its key, so nobody would pay through Hirakumi. Make your API require a key and add it on this page. Publishing waits until then.",
    );
    expect(screen.getByRole("link", { name: "Add your API's key" })).toHaveAttribute("href", `#${KEY_FORM_ID}`);
    expect(screen.getByText("Checked 2026-10-07 17:20 UTC")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("\"Check again\" runs the check and shows its message, then the protected result", async () => {
    const message = "Anyone can call this API for free at https://a.example/price, so nobody would pay through Hirakumi. Make your API require a key and add it on this page.";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ exposure: "open", checkedAt: "2026-10-07T17:21:00.000Z", message, endpoints: [] }))
      .mockResolvedValueOnce(jsonResponse({ exposure: "protected", checkedAt: "2026-10-07T17:22:00.000Z", message: null, endpoints: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ExposureCard apiId="api_1" initial={{ exposure: "unknown", checkedAt: "2026-10-07T17:20:00.000Z" }} />);
    expect(screen.getByTestId("exposure-text")).toHaveTextContent(/couldn't tell whether every endpoint refuses calls without your key/);
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/apis/api_1/exposure", expect.objectContaining({ method: "POST" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/Your API refuses calls without its key/)).toBeInTheDocument();
    expect(screen.getByTestId("exposure-card")).toHaveAttribute("data-exposure", "protected");
    expect(screen.queryByRole("link", { name: "Add your API's key" })).toBeNull();
  });

  it("shows a failed check's error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "We couldn't find that API in your account." }, 404)));
    const user = userEvent.setup();
    render(<ExposureCard apiId="api_1" initial={null} />);
    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't find that API in your account.");
  });

  it("formats the time the same everywhere", () => {
    expect(checkedLabel("2026-01-02T03:04:59.999Z")).toBe("2026-01-02 03:04 UTC");
  });
});
