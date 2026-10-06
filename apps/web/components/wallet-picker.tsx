"use client";

import { useEffect, useState } from "react";
import { isMobileBrowser, listWallets, sameWallets, type WalletInfo } from "@/lib/wallet-client";

const LOOK_EVERY_MS = 300;
const LOOK_FOR_MS = 3_000;

/**
 * The CIP-30 wallets in this browser, deduplicated. Null until the first look after hydration, so
 * callers can show a skeleton instead of a "no wallet" flash. Extensions inject window.cardano
 * asynchronously, so it keeps looking for about 3 seconds.
 */
export function useWallets(): WalletInfo[] | null {
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  useEffect(() => {
    const look = () => {
      const found = listWallets();
      setWallets((prev) => (sameWallets(prev, found) ? prev : found));
    };
    look();
    const startedAt = Date.now();
    const t = setInterval(() => {
      look();
      if (Date.now() - startedAt >= LOOK_FOR_MS) clearInterval(t);
    }, LOOK_EVERY_MS);
    return () => clearInterval(t);
  }, []);
  return wallets;
}

/** True after hydration on a phone or tablet browser. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => setMobile(isMobileBrowser()), []);
  return mobile;
}

/** The wallet's own icon (a data URL the extension provides), with a neutral square when it has none. */
export function WalletIcon({ icon, className = "size-5" }: { icon: string; className?: string }) {
  if (!icon) return <span aria-hidden className={`${className} inline-block shrink-0 rounded-[2px] border border-ink bg-chalk`} />;
  // eslint-disable-next-line @next/next/no-img-element -- extension-provided data URL, not a static asset
  return <img src={icon} alt="" aria-hidden className={`${className} shrink-0 rounded-[2px] object-contain outline outline-1 -outline-offset-1 outline-black/10`} />;
}

export const GET_A_WALLET = [
  { name: "Lace", href: "https://www.lace.io" },
  { name: "Eternl", href: "https://eternl.io" },
  { name: "Vespr", href: "https://vespr.xyz" },
  { name: "Typhon", href: "https://typhonwallet.io" },
] as const;

/** No wallet in this browser: where to get one, and the one setting that matters. */
export function GetAWallet() {
  return (
    <div className="space-y-4">
      <p className="text-body-lg font-medium">No Cardano wallet found in this browser.</p>
      <div>
        <h2 className="text-caption font-semibold uppercase tracking-[0.04em]">Get a wallet</h2>
        <ul className="mt-2 divide-y divide-silver rounded-[2px] border-2 border-ink bg-frost">
          {GET_A_WALLET.map((w) => (
            <li key={w.name}>
              <a
                href={w.href}
                target="_blank"
                rel="noreferrer"
                className="group flex min-h-12 items-center justify-between gap-4 px-4 py-3 transition-colors duration-150 hover:bg-ice"
              >
                <span className="min-w-0">
                  <span className="block font-semibold underline-offset-4 group-hover:underline">{w.name}</span>
                  <span className="block text-caption text-graphite">Then switch it to preprod in its network settings.</span>
                </span>
                <span aria-hidden className="shrink-0 transition-transform duration-150 ease-[var(--ease-press)] group-hover:translate-x-0.5">↗</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-body text-graphite">Reload this page once the wallet is installed.</p>
    </div>
  );
}

export function MobileNote() {
  return (
    <p className="rounded-[2px] border-2 border-ink bg-canary p-3 text-body">
      Cardano wallet extensions need a desktop browser for now. Open this page on a computer to sign in.
    </p>
  );
}
