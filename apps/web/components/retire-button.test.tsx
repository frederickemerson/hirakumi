// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RetireButton } from "./retire-button";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

describe("RetireButton (QA 12)", () => {
  it("is called Retire, like everywhere else, and its dialog says what retiring does", async () => {
    render(<RetireButton apiId="api_1" name="Price API" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retire" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Retire Price API?" });
    expect(dialog).toHaveTextContent("Retiring stops new sales and takes the API off the agent market.");
    expect(document.body.textContent).not.toMatch(/Remove from the market/);
  });
});
