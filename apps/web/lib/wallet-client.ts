import { RequestError } from "./client-fetch";
import { ClickAgainError, connectEmailWallet } from "./utxos-wallet";

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

/** The email wallet needs one more click before it can sign (see utxos-wallet). Show it as a step, not an error. */
export const needsAnotherClick = (e: unknown): e is ClickAgainError => e instanceof ClickAgainError;

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

/** The email or Google wallet (UTXOS). Not a browser extension: listed only when a UTXOS project is configured. */
export const EMAIL_WALLET_ID = "hirakumi:email";
export const EMAIL_WALLET_LABEL = "Continue with email or Google";
const MAIL_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
)}`;

/** The UTXOS project id, inlined at build time. Unset: the email wallet is off and nothing about it shows. */
export function emailWalletProjectId(): string | null {
  return process.env.NEXT_PUBLIC_UTXOS_PROJECT_ID?.trim() || null;
}

export const isEmailWallet = (w: Pick<WalletInfo, "id">) => w.id === EMAIL_WALLET_ID;

/** The button text for a wallet: "Log in with Lace", or the email wallet's own label. */
export function walletAction(verb: string, w: WalletInfo): string {
  return isEmailWallet(w) ? EMAIL_WALLET_LABEL : `${verb} with ${w.name}`;
}

/** The browser's extension wallets (CIP-30), deduplicated. */
function listInjectedWallets(): WalletInfo[] {
  if (typeof window === "undefined" || !window.cardano) return [];
  return dedupeWallets(
    Object.entries(window.cardano)
      .filter(([, w]) => !!w && typeof w.enable === "function" && typeof w.name === "string")
      .map(([id, w]) => ({ id, name: w!.name, icon: w!.icon ?? "" })),
  );
}

/** Extension wallets, then the email wallet when it is configured. */
export function listWallets(): WalletInfo[] {
  if (typeof window === "undefined") return [];
  const injected = listInjectedWallets();
  return emailWalletProjectId() ? [...injected, { id: EMAIL_WALLET_ID, name: "email or Google", icon: MAIL_ICON }] : injected;
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

export async function connectWallet(id: string): Promise<{ api: Cip30Api; addressHex: string }> {
  if (id === EMAIL_WALLET_ID) {
    const projectId = emailWalletProjectId();
    if (!projectId) throw new WalletError("Email sign-in isn't available here. Use a browser wallet.");
    const api = await connectEmailWallet(projectId);
    if ((await api.getNetworkId()) !== 0) throw new WalletError("This wallet is on mainnet. Hirakumi runs on preprod.");
    return { api, addressHex: await api.getChangeAddress() };
  }
  const injected = window.cardano?.[id];
  if (!injected) throw new WalletError("That wallet isn't available any more. Reload the page.");
  const api = await injected.enable();
  if ((await api.getNetworkId()) !== 0) {
    throw new WalletError("Your wallet is on mainnet. Switch it to the preprod test network, then try again.");
  }
  return { api, addressHex: await api.getChangeAddress() };
}

function textToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function signText(api: Cip30Api, addressHex: string, text: string): Promise<{ signature: string; key: string }> {
  return api.signData(addressHex, textToHex(text));
}

export function walletErrorMessage(e: unknown): string {
  if (e instanceof WalletError || e instanceof RequestError || e instanceof ClickAgainError) return e.message;
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
