// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type Params = { onApiInject: (id: string) => void; onApiEject: () => void; dAppInfo: { name: string; url: string } };
const created: { params: Params; generateQRCode: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];

vi.mock("@fabianbormann/cardano-peer-connect", () => ({
  DAppPeerConnect: class {
    generateQRCode = vi.fn((el: HTMLElement) => { el.innerHTML = "<svg data-testid='qr'></svg>"; });
    destroy = vi.fn();
    getAddress = () => "peer-1";
    constructor(params: Params) {
      created.push({ params, generateQRCode: this.generateQRCode, destroy: this.destroy });
    }
  },
}));

import { PhoneWalletConnect, WALLETS_CHANGED } from "./phone-wallet-connect";

describe("PhoneWalletConnect (CIP-45)", () => {
  afterEach(() => { created.length = 0; });

  it("shows a QR code after the user asks for it, named for this site", async () => {
    render(<PhoneWalletConnect />);
    expect(created).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Use a wallet on your phone" }));
    await vi.waitFor(() => expect(created[0]?.generateQRCode).toHaveBeenCalled());
    expect(created[0].params.dAppInfo.name).toBe("Hirakumi");
    expect(screen.getByText("Waiting for your phone…")).toBeInTheDocument();
  });

  it("when the phone wallet connects, announces the new wallet and hands its id over", async () => {
    const onConnected = vi.fn();
    const changed = vi.fn();
    window.addEventListener(WALLETS_CHANGED, changed);
    render(<PhoneWalletConnect onConnected={onConnected} />);
    await userEvent.click(screen.getByRole("button", { name: "Use a wallet on your phone" }));
    await vi.waitFor(() => expect(created).toHaveLength(1));
    act(() => created[0].params.onApiInject("eternl-p2p"));
    expect(onConnected).toHaveBeenCalledWith("eternl-p2p");
    expect(changed).toHaveBeenCalled();
    expect(screen.getByText(/Phone wallet connected/)).toBeInTheDocument();
    window.removeEventListener(WALLETS_CHANGED, changed);
  });

  it("closes the peer connection when the page goes away", async () => {
    const { unmount } = render(<PhoneWalletConnect />);
    await userEvent.click(screen.getByRole("button", { name: "Use a wallet on your phone" }));
    await vi.waitFor(() => expect(created).toHaveLength(1));
    unmount();
    expect(created[0].destroy).toHaveBeenCalled();
  });
});
