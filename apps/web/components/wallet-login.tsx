"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Elapsed } from "@/components/elapsed";
import { InlineError, InlineStatus } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PhoneWalletConnect } from "@/components/phone-wallet-connect";
import { GetAWallet, MobileNote, useIsMobile, useWallets, WalletIcon } from "@/components/wallet-picker";
import { setAuth } from "@/lib/auth-client";
import { postJson } from "@/lib/client-fetch";
import { shortAddress } from "@/lib/copy";
import { startRouteProgress } from "@/lib/route-progress";
import {
  checkPreprodFunds,
  connectWallet,
  signText,
  walletAddresses,
  walletErrorMessage,
  type Cip30Api,
} from "@/lib/wallet-client";

export const FAUCET_URL = "https://docs.cardano.org/cardano-testnets/tools/faucet";

type Phase =
  | { kind: "idle" }
  | { kind: "working"; text: string; walletId: string }
  | { kind: "no_funds"; walletId: string }
  | { kind: "error"; text: string };

export function WalletLogin({ next }: { next: string }) {
  const router = useRouter();
  const wallets = useWallets();
  const mobile = useIsMobile();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // The connected wallet, kept while the seller decides what to do about a wallet with no preprod funds.
  const connected = useRef<{ api: Cip30Api; addressHex: string } | null>(null);

  async function signIn(walletId: string) {
    try {
      setPhase({ kind: "working", walletId, text: "Connecting to your wallet…" });
      const conn = await connectWallet(walletId);
      connected.current = conn;
      setPhase({ kind: "working", walletId, text: "Checking this wallet on preprod…" });
      // Preprod and preview both report network id 0; Blockfrost preprod tells them apart.
      const funds = await checkPreprodFunds(await walletAddresses(conn.api, conn.addressHex));
      if (funds === "empty") {
        setPhase({ kind: "no_funds", walletId });
        return;
      }
      await finishSignIn(walletId);
    } catch (e) {
      setPhase({ kind: "error", text: walletErrorMessage(e) });
    }
  }

  async function finishSignIn(walletId: string) {
    const conn = connected.current;
    if (!conn) return;
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
      setPhase({ kind: "error", text: walletErrorMessage(e) });
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
              <span>Sign in with {w.name}</span>
            </Button>
          </li>
        ))}
      </ul>
      {!mobile && <PhoneWalletConnect onConnected={(id) => void signIn(id)} />}
      {phase.kind === "working" && (
        <InlineStatus busy>
          {phase.text} <Elapsed prefix=" " className="text-graphite" />
        </InlineStatus>
      )}
      {phase.kind === "no_funds" && (
        <div role="alert" className="space-y-3 rounded-[2px] border-2 border-ink border-l-8 border-l-canary bg-frost p-4 text-body">
          <p className="font-medium">
            This wallet has no preprod funds. Get test ADA from the{" "}
            <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">Cardano faucet</a>.
          </p>
          <p className="text-graphite">If your wallet is on preview, switch it to preprod first. You can still sign in now; signing is free.</p>
          <Button size="sm" variant="outline" onClick={() => void finishSignIn(phase.walletId)}>Sign in anyway</Button>
        </div>
      )}
      {phase.kind === "error" && <InlineError>{phase.text}</InlineError>}
    </div>
  );
}
