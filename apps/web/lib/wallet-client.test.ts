// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetEmailWallet } from "./utxos-wallet";
import {
  connectWallet,
  EMAIL_WALLET_ID,
  EMAIL_WALLET_LABEL,
  emailWalletProjectId,
  listWallets,
  needsAnotherClick,
  walletAction,
  walletErrorMessage,
} from "./wallet-client";

const sdk = vi.hoisted(() => ({ enable: vi.fn() }));
vi.mock("@utxos/sdk", () => ({ Web3Wallet: { enable: sdk.enable } }));

const lace = { name: "Lace", icon: "data:lace", enable: async () => ({}) as never };

afterEach(() => {
  delete window.cardano;
  vi.unstubAllEnvs();
  sdk.enable.mockReset();
  forgetEmailWallet();
});

describe("the email wallet in the wallet list", () => {
  it("is off without NEXT_PUBLIC_UTXOS_PROJECT_ID: only the browser's wallets are listed", () => {
    vi.stubEnv("NEXT_PUBLIC_UTXOS_PROJECT_ID", "");
    window.cardano = { lace };
    expect(emailWalletProjectId()).toBeNull();
    expect(listWallets().map((w) => w.id)).toEqual(["lace"]);
  });

  it("is listed after the browser's wallets when configured, and alone when there are none", () => {
    vi.stubEnv("NEXT_PUBLIC_UTXOS_PROJECT_ID", "proj");
    window.cardano = { lace };
    expect(listWallets().map((w) => w.id)).toEqual(["lace", EMAIL_WALLET_ID]);
    delete window.cardano;
    expect(listWallets().map((w) => w.id)).toEqual([EMAIL_WALLET_ID]);
  });

  it("has its own button text; extension wallets keep theirs", () => {
    expect(walletAction("Log in", { id: "lace", name: "Lace", icon: "" })).toBe("Log in with Lace");
    expect(walletAction("Pay", { id: EMAIL_WALLET_ID, name: "email or Google", icon: "" })).toBe(EMAIL_WALLET_LABEL);
    expect(EMAIL_WALLET_LABEL).toBe("Continue with email or Google");
  });
});

describe("connectWallet with the email wallet", () => {
  const cardano = {
    getNetworkId: async () => 0,
    getChangeAddress: async () => "00aabb",
    getChangeAddressBech32: async () => "addr_test1qexample",
    getUsedAddresses: async () => ["00aabb"],
    signData: async () => ({ signature: "84", key: "a4" }),
    signTx: async () => "a100",
  };

  it("connects through UTXOS on preprod, asks for one more click, then returns its hex address", async () => {
    vi.stubEnv("NEXT_PUBLIC_UTXOS_PROJECT_ID", "proj");
    sdk.enable.mockResolvedValue({ cardano });
    const first = await connectWallet(EMAIL_WALLET_ID).catch((e) => e);
    expect(needsAnotherClick(first)).toBe(true);
    expect(walletErrorMessage(first)).toMatch(/Click Continue with email or Google again/);
    expect(sdk.enable).toHaveBeenCalledWith({ projectId: "proj", networkId: 0 });
    const { addressHex } = await connectWallet(EMAIL_WALLET_ID);
    expect(addressHex).toBe("00aabb");
    expect(sdk.enable).toHaveBeenCalledTimes(1);
  });

  it("is refused when the project id is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_UTXOS_PROJECT_ID", "");
    await expect(connectWallet(EMAIL_WALLET_ID)).rejects.toThrow(/isn't available/);
    expect(sdk.enable).not.toHaveBeenCalled();
  });

  it("does not touch UTXOS for an extension wallet", async () => {
    vi.stubEnv("NEXT_PUBLIC_UTXOS_PROJECT_ID", "proj");
    window.cardano = { lace: { ...lace, enable: async () => ({ getNetworkId: async () => 0, getChangeAddress: async () => "00cc" }) as never } };
    expect((await connectWallet("lace")).addressHex).toBe("00cc");
    expect(sdk.enable).not.toHaveBeenCalled();
  });
});
