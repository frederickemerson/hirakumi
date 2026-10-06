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

/**
 * Some wallets inject themselves under two keys (a legacy and a current one), which would show the
 * same wallet twice. Same name and same icon means the same wallet: keep the first.
 */
export function dedupeWallets(wallets: WalletInfo[]): WalletInfo[] {
  const seen = new Set<string>();
  return wallets.filter((w) => {
    const key = JSON.stringify([w.name.trim().toLowerCase(), w.icon]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function listWallets(): WalletInfo[] {
  if (typeof window === "undefined" || !window.cardano) return [];
  return dedupeWallets(
    Object.entries(window.cardano)
      .filter(([, w]) => !!w && typeof w.enable === "function" && typeof w.name === "string")
      .map(([id, w]) => ({ id, name: w!.name, icon: w!.icon ?? "" })),
  );
}

export function sameWallets(a: WalletInfo[] | null, b: WalletInfo[]): boolean {
  return !!a && a.length === b.length && a.every((w, i) => w.id === b[i].id);
}

/** Wallet extensions only exist in desktop browsers today. Prefers the browser's own answer (UA-CH). */
export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === "boolean") return uaData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** Addresses to check for preprod history: the change address plus a few used ones, deduplicated. */
export async function walletAddresses(api: Cip30Api, changeAddressHex: string, max = 5): Promise<string[]> {
  const used = await api.getUsedAddresses().catch(() => [] as string[]);
  return [...new Set([changeAddressHex, ...used])].slice(0, max);
}

export type PreprodFunds = "funded" | "empty" | "unknown";

/** Asks the server (which holds the Blockfrost key) whether these addresses have any preprod ADA. */
export async function checkPreprodFunds(addresses: string[]): Promise<PreprodFunds> {
  try {
    const res = await fetch("/api/wallet/preprod-funds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addresses }),
    });
    if (!res.ok) return "unknown";
    const data = (await res.json()) as { status?: unknown };
    return data.status === "funded" || data.status === "empty" ? data.status : "unknown";
  } catch {
    return "unknown";
  }
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
