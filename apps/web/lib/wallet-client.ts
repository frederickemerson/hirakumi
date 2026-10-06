import { RequestError } from "./client-fetch";

/** The subset of the CIP-30 API Hirakumi uses (see connect-wallet skill reference). */
export type Cip30Api = {
  getNetworkId(): Promise<number>;
  getChangeAddress(): Promise<string>;
  getUsedAddresses(): Promise<string[]>;
  signData(addr: string, payloadHex: string): Promise<{ signature: string; key: string }>;
};

type InjectedWallet = { name: string; icon?: string; apiVersion?: string; enable(): Promise<Cip30Api> };

declare global {
  interface Window {
    cardano?: Record<string, InjectedWallet | undefined>;
  }
}

export type WalletInfo = { id: string; name: string; icon: string };

export class WalletError extends Error {}

export function listWallets(): WalletInfo[] {
  if (typeof window === "undefined" || !window.cardano) return [];
  return Object.entries(window.cardano)
    .filter(([, w]) => !!w && typeof w.enable === "function" && typeof w.name === "string")
    .map(([id, w]) => ({ id, name: w!.name, icon: w!.icon ?? "" }));
}

export async function connectWallet(id: string): Promise<{ api: Cip30Api; addressHex: string }> {
  const injected = window.cardano?.[id];
  if (!injected) throw new WalletError("That wallet isn't available any more. Reload the page.");
  const api = await injected.enable();
  if ((await api.getNetworkId()) !== 0) {
    throw new WalletError("Your wallet is on mainnet. Switch it to the preprod test network, then try again.");
  }
  return { api, addressHex: await api.getChangeAddress() };
}

export function textToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function signText(api: Cip30Api, addressHex: string, text: string): Promise<{ signature: string; key: string }> {
  return api.signData(addressHex, textToHex(text));
}

export function walletErrorMessage(e: unknown): string {
  if (e instanceof WalletError || e instanceof RequestError) return e.message;
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "number") {
    switch ((e as { code: number }).code) {
      case -3:
        return "You declined the connection in your wallet. Try again and choose Connect.";
      case -4:
        return "Your wallet account changed. Try again.";
      case 3:
        return "You cancelled signing in your wallet. Nothing was signed.";
      case 2:
        return "This wallet address can't sign messages. Use a normal payment address.";
      default:
        return "Your wallet reported a problem. Try again.";
    }
  }
  return "Something went wrong with your wallet. Try again.";
}
