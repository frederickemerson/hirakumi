"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Elapsed } from "@/components/elapsed";
import { InlineError, InlineStatus } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PhoneWalletConnect } from "@/components/phone-wallet-connect";
import { BROWSER_WALLET_TOO, GetAWallet, MobileNote, onlyEmailWallet, useIsMobile, useWallets, WalletIcon } from "@/components/wallet-picker";
import { setAuth } from "@/lib/auth-client";
import { postJson } from "@/lib/client-fetch";
import { shortAddress } from "@/lib/copy";
import { startRouteProgress } from "@/lib/route-progress";
import {
  connectWallet,
  needsAnotherClick,
  signText,
  walletAction,
  walletErrorMessage,
  type Cip30Api,
} from "@/lib/wallet-client";

type Phase =
  | { kind: "idle" }
  | { kind: "working"; text: string; walletId: string }
  | { kind: "again"; text: string }
  | { kind: "error"; text: string };

export function WalletLogin({ next }: { next: string }) {
  const router = useRouter();
  const wallets = useWallets();
  const mobile = useIsMobile();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Signing in only signs a message, so it needs no funds: a new wallet (an email wallet always starts empty) goes
  // straight to the signature. Funds are checked where they are spent, when paying.
  async function signIn(walletId: string) {
    let conn: { api: Cip30Api; addressHex: string };
    try {
      setPhase({ kind: "working", walletId, text: "Connecting to your wallet…" });
      conn = await connectWallet(walletId);
    } catch (e) {
      setPhase(needsAnotherClick(e) ? { kind: "again", text: e.message } : { kind: "error", text: walletErrorMessage(e) });
      return;
    }
    try {
      const challenge = await postJson<{ message: string; nonceToken: string }>("/api/auth/nonce", { address: conn.addressHex });
      setPhase({ kind: "working", walletId, text: "Approve the sign-in message in your wallet. It costs nothing and moves no funds." });
      const sig = await signText(conn.api, conn.addressHex, challenge.message);
      setPhase({ kind: "working", walletId, text: "Signature received. Opening your dashboard…" });
      const seller = await postJson<{ address: string }>("/api/auth/verify", { nonceToken: challenge.nonceToken, ...sig });
      // The header is a client island outside this page: tell it now instead of waiting for a reload.
      setAuth({ status: "in", address: shortAddress(seller.address) });
      startRouteProgress();
      router.push(next);
    } catch (e) {
      setPhase(needsAnotherClick(e) ? { kind: "again", text: e.message } : { kind: "error", text: walletErrorMessage(e) });
    }
  }

  if (wallets === null) {
    return (
      <div role="status" aria-label="Looking for wallets" className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (wallets.length === 0) {
    return (
      <div className="space-y-4">
        {mobile && <MobileNote />}
        {!mobile && <PhoneWalletConnect onConnected={(id) => void signIn(id)} />}
        <GetAWallet />
      </div>
    );
  }
  const busy = phase.kind === "working";
  return (
    <div className="space-y-4">
      {mobile && <MobileNote />}
      <ul className="grid gap-3" aria-label="Wallets in this browser">
        {wallets.map((w) => (
          <li key={w.id}>
            <Button
              variant="outline"
              className="w-full justify-start gap-3"
              pending={busy && phase.walletId === w.id}
              disabled={busy}
              onClick={() => signIn(w.id)}
            >
              {!(busy && phase.walletId === w.id) && <WalletIcon icon={w.icon} />}
              <span>{walletAction("Log in", w)}</span>
            </Button>
          </li>
        ))}
      </ul>
      {!mobile && <PhoneWalletConnect onConnected={(id) => void signIn(id)} />}
      {onlyEmailWallet(wallets) && <GetAWallet title={BROWSER_WALLET_TOO} />}
      {phase.kind === "again" && <InlineStatus>{phase.text}</InlineStatus>}
      {phase.kind === "working" && (
        <InlineStatus busy>
          {phase.text} <Elapsed prefix=" " className="text-graphite" />
        </InlineStatus>
      )}
      {phase.kind === "error" && <InlineError>{phase.text}</InlineError>}
    </div>
  );
}
