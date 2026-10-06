// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@/lib/client-fetch";
import { ConfirmDialog } from "./confirm-dialog";

function setup(over: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = over.onConfirm ?? vi.fn(async () => undefined);
  render(
    <ConfirmDialog
      triggerLabel="Delete"
      title="Delete Weather API?"
      description="Its endpoints, test calls and prices go too."
      confirmLabel="Delete API"
      pendingLabel="Deleting…"
      typeToConfirm="Weather API"
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm, user: userEvent.setup() };
}

describe("ConfirmDialog", () => {
  it("opens as a labelled modal dialog that names what will go", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Weather API?" });
    expect(dialog).toHaveAccessibleDescription(/Its endpoints, test calls and prices go too\./);
  });

  it("enables the confirm button only when the name is typed exactly", async () => {
    const { user, onConfirm } = setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("button", { name: "Delete API" });
    const input = screen.getByLabelText("Type Weather API to confirm");
    expect(confirm).toBeDisabled();
    await user.type(input, "weather api");
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, "Weather API ");
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, "Weather API");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirms with Enter once the name matches", async () => {
    const { user, onConfirm } = setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const input = await screen.findByLabelText("Type Weather API to confirm");
    await user.type(input, "Weather{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    await user.type(input, " API{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes on Esc and returns focus to the button that opened it", async () => {
    const { user } = setup();
    const trigger = screen.getByRole("button", { name: "Delete" });
    await user.click(trigger);
    await screen.findByRole("alertdialog");
    await waitFor(() => expect(screen.getByLabelText("Type Weather API to confirm")).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps focus inside the dialog while tabbing", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    for (let i = 0; i < 6; i++) {
      await user.tab();
      // Base UI's focus guards bounce focus back in on the next frame.
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    }
  });

  it("shows a pending button and can't be dismissed while the request runs", async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { user } = setup({ onConfirm });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.type(await screen.findByLabelText("Type Weather API to confirm"), "Weather API");
    await user.click(screen.getByRole("button", { name: "Delete API" }));
    const pending = screen.getByRole("button", { name: "Deleting…" });
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("stays open and shows the server's reason when it fails", async () => {
    const onConfirm = vi.fn(async () => {
      throw new RequestError("This API is on the Masumi registry. Retire it instead.");
    });
    const { user } = setup({ onConfirm });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.type(await screen.findByLabelText("Type Weather API to confirm"), "Weather API");
    await user.click(screen.getByRole("button", { name: "Delete API" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This API is on the Masumi registry. Retire it instead.");
    expect(screen.getByRole("button", { name: "Delete API" })).toBeEnabled();
  });

  it("asks without typing when there is no name to type (Retire)", async () => {
    const { user, onConfirm } = setup({ typeToConfirm: undefined, triggerLabel: "Retire", confirmLabel: "Retire API" });
    await user.click(screen.getByRole("button", { name: "Retire" }));
    await screen.findByRole("alertdialog");
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retire API" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
