// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TRY_DOWN_REASON, TryLiveLink } from "./try-live-link";

describe("TryLiveLink", () => {
  it("a live, healthy API gets a working link to its try page", () => {
    render(<TryLiveLink apiId="api_1" state="live" health="healthy" />);
    expect(screen.getByRole("link", { name: "Try it live" })).toHaveAttribute("href", "/p/api_1/try");
  });

  it("a Down API gets a disabled button that says why, never a dead link", () => {
    render(<TryLiveLink apiId="api_1" state="live" health="down" />);
    expect(screen.queryByRole("link", { name: "Try it live" })).toBeNull();
    const button = screen.getByRole("button", { name: "Try it live" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(TRY_DOWN_REASON);
  });

  it("an API that is not live has nothing to try", () => {
    const { container } = render(<TryLiveLink apiId="api_1" state="priced" health="healthy" />);
    expect(container).toBeEmptyDOMElement();
  });
});
