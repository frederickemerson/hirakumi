// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cip30Api } from "@/lib/wallet-client";
import { jsonResponse } from "@/test/http";
import { WalletLogin } from "./wallet-login";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

function installWallet(api: Partial<Cip30Api> = {}) {
  window.cardano = {
    testwallet: {
      name: "Test Wallet",
      icon: "",
      enable: async () => ({
        getNetworkId: async () => 0,
        getChangeAddress: async () => "00abcd",
        getUsedAddresses: async () => ["00abcd"],
        signData: async () => ({ signature: "84a1", key: "a401" }),
        ...api,
      }),
    },
  };
}

afterEach(() => {
  delete window.cardano;
  vi.unstubAllGlobals();
  nav.push.mockReset();
});

describe("WalletLogin", () => {
  it("tells the seller to install a wallet when none is present", async () => {
    render(<WalletLogin next="/apis" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No Cardano wallet found in this browser");
  });

  it("signs the server's message and goes to the next page", async () => {
    const signData = vi.fn(async () => ({ signature: "84a1", key: "a401" }));
    installWallet({ signData });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ address: "addr_test1qq", message: "Sign in to Hirakumi", nonceToken: "n.t" }))
      .mockResolvedValueOnce(jsonResponse({ sellerId: "sel_1", address: "addr_test1qq" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<WalletLogin next="/apis/api_1" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));

    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1"));
    expect(signData).toHaveBeenCalledWith("00abcd", Buffer.from("Sign in to Hirakumi").toString("hex"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ address: "00abcd" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ nonceToken: "n.t", signature: "84a1", key: "a401" });
  });

  it("explains a cancelled signature", async () => {
    installWallet({ signData: async () => Promise.reject({ code: 3, info: "user declined" }) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ address: "a", message: "m", nonceToken: "n" })));
    render(<WalletLogin next="/apis" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You cancelled signing in your wallet. Nothing was signed.");
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("refuses a wallet on mainnet before asking the server", async () => {
    installWallet({ getNetworkId: async () => 1 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<WalletLogin next="/apis" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your wallet is on mainnet. Switch it to the preprod test network");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's plain-English error", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "Switch your wallet to the Cardano preprod test network, then try again." }, 400)));
    render(<WalletLogin next="/apis" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Switch your wallet to the Cardano preprod test network");
  });
});
