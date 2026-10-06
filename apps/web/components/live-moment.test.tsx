// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveMoment, shouldCelebrate } from "./live-moment";

afterEach(() => window.localStorage.clear());

describe("LiveMoment", () => {
  it("celebrates only an API that went live in the last day, and only once", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    expect(shouldCelebrate("2026-10-06T11:58:00Z", false, now)).toBe(true);
    expect(shouldCelebrate("2026-10-06T11:58:00Z", true, now)).toBe(false);
    expect(shouldCelebrate("2026-10-04T11:58:00Z", false, now)).toBe(false);
    expect(shouldCelebrate(null, false, now)).toBe(false);
  });

  it("shows the registry token and a try link, then never again in this browser", async () => {
    const liveSince = new Date(Date.now() - 60_000).toISOString();
    const url = "https://preprod.cardanoscan.io/token/abc";
    const { unmount } = render(<LiveMoment apiId="api_1" liveSince={liveSince} registryUrl={url} />);
    expect(await screen.findByRole("heading", { name: "Your API is live" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Try it live" })).toHaveAttribute("href", "/p/api_1/try");
    expect(screen.getByRole("link", { name: "See the registry token on Cardanoscan" })).toHaveAttribute("href", url);
    unmount();
    render(<LiveMoment apiId="api_1" liveSince={liveSince} registryUrl={url} />);
    expect(screen.queryByRole("heading", { name: "Your API is live" })).toBeNull();
  });

  it("if the API is already Down, the try button is disabled and says why", async () => {
    render(<LiveMoment apiId="api_2" liveSince={new Date(Date.now() - 60_000).toISOString()} registryUrl={null} health="down" />);
    expect(await screen.findByRole("heading", { name: "Your API is live" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Try it live" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try it live" })).toBeDisabled();
  });
});
