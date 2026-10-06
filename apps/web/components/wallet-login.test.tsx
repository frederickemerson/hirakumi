// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "@/lib/auth-client";
import { dedupeWallets, listWallets, type Cip30Api } from "@/lib/wallet-client";
import { jsonResponse } from "@/test/http";
import { WalletLogin } from "./wallet-login";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

function installWallet(api: Partial<Cip30Api> = {}) {
  window.cardano = {
    testwallet: {
      name: "Test Wallet",
      icon: "data:image/svg+xml;base64,AAAA",
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

/** Routes fetch by URL so the order of the funds check and the auth calls doesn't matter. */
function routeFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return routes[key]();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const bodyOf = (m: ReturnType<typeof routeFetch>, url: string) => JSON.parse(String(m.mock.calls.find((c) => c[0] === url)![1]!.body));

afterEach(() => {
  delete window.cardano;
  vi.unstubAllGlobals();
  nav.push.mockReset();
});

describe("dedupeWallets", () => {
  it("keeps one entry per wallet when an extension injects itself twice", () => {
    const lace = { name: "Lace", icon: "data:lace" };
    expect(
      dedupeWallets([
        { id: "lace", ...lace },
        { id: "eternl", name: "eternl", icon: "data:eternl" },
        { id: "lace2", ...lace },
        { id: "ccvault", name: "Eternl", icon: "data:other" },
      ]).map((w) => w.id),
    ).toEqual(["lace", "eternl", "ccvault"]);
  });

  it("is applied to the wallets found in window.cardano", () => {
    const wallet = { name: "Lace", icon: "data:lace", enable: async () => ({}) as Cip30Api };
    window.cardano = { lace: wallet, laceLegacy: { ...wallet } };
    expect(listWallets().map((w) => w.id)).toEqual(["lace"]);
  });
});

describe("WalletLogin", () => {
  it("offers wallets to install, each with the preprod hint, when none is present", async () => {
    render(<WalletLogin next="/apis" />);
    expect(screen.getByRole("status", { name: "Looking for wallets" })).toBeInTheDocument();
    expect(await screen.findByText("No Cardano wallet found in this browser.", undefined, { timeout: 4000 })).toBeInTheDocument();
    for (const [name, href] of [["Lace", "https://www.lace.io"], ["Eternl", "https://eternl.io"], ["Vespr", "https://vespr.xyz"], ["Typhon", "https://typhonwallet.io"]]) {
      const link = screen.getByRole("link", { name: new RegExp(`^${name}`) });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveTextContent("switch it to preprod");
    }
  });

  it("lists each wallet with its icon", async () => {
    installWallet();
    render(<WalletLogin next="/apis" />);
    const button = await screen.findByRole("button", { name: "Sign in with Test Wallet" });
    expect(button.querySelector("img")).toHaveAttribute("src", "data:image/svg+xml;base64,AAAA");
  });

  it("signs the server's message and goes to the next page", async () => {
    const signData = vi.fn(async () => ({ signature: "84a1", key: "a401" }));
    installWallet({ signData });
    const fetchMock = routeFetch({
      "/api/wallet/preprod-funds": () => jsonResponse({ status: "funded" }),
      "/api/auth/nonce": () => jsonResponse({ address: "addr_test1qq", message: "Sign in to Hirakumi", nonceToken: "n.t" }),
      "/api/auth/verify": () => jsonResponse({ sellerId: "sel_1", address: "addr_test1qq" }),
    });

    render(<WalletLogin next="/apis/api_1" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));

    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1"));
    // The header learns about the new session without a reload.
    expect(getAuth()).toEqual({ status: "in", address: "addr_test1qq" });
    expect(signData).toHaveBeenCalledWith("00abcd", Buffer.from("Sign in to Hirakumi").toString("hex"));
    expect(bodyOf(fetchMock, "/api/wallet/preprod-funds")).toEqual({ addresses: ["00abcd"] });
    expect(bodyOf(fetchMock, "/api/auth/nonce")).toEqual({ address: "00abcd" });
    expect(bodyOf(fetchMock, "/api/auth/verify")).toEqual({ nonceToken: "n.t", signature: "84a1", key: "a401" });
  });

  it("warns about a wallet with no preprod funds and still lets the seller sign in", async () => {
    installWallet();
    routeFetch({
      "/api/wallet/preprod-funds": () => jsonResponse({ status: "empty" }),
      "/api/auth/nonce": () => jsonResponse({ address: "a", message: "m", nonceToken: "n" }),
      "/api/auth/verify": () => jsonResponse({ sellerId: "s", address: "a" }),
    });
    const user = userEvent.setup();
    render(<WalletLogin next="/apis" />);
    await user.click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This wallet has no preprod funds. Get test ADA from the Cardano faucet");
    expect(within(alert).getByRole("link", { name: "Cardano faucet" })).toHaveAttribute("href", "https://docs.cardano.org/cardano-testnets/tools/faucet");
    expect(nav.push).not.toHaveBeenCalled();
    await user.click(within(alert).getByRole("button", { name: "Sign in anyway" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis"));
  });

  it("explains a cancelled signature", async () => {
    installWallet({ signData: async () => Promise.reject({ code: 3, info: "user declined" }) });
    routeFetch({
      "/api/wallet/preprod-funds": () => jsonResponse({ status: "unknown" }),
      "/api/auth/nonce": () => jsonResponse({ address: "a", message: "m", nonceToken: "n" }),
    });
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
    routeFetch({
      "/api/wallet/preprod-funds": () => jsonResponse({ status: "funded" }),
      "/api/auth/nonce": () => jsonResponse({ error: "Switch your wallet to the Cardano preprod test network, then try again." }, 400),
    });
    render(<WalletLogin next="/apis" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with Test Wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Switch your wallet to the Cardano preprod test network");
  });
});
