"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Elapsed } from "@/components/elapsed";
import { InlineError, InlineStatus } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { postJson } from "@/lib/client-fetch";
import { startRouteProgress } from "@/lib/route-progress";
import { connectWallet, listWallets, signText, walletErrorMessage, type WalletInfo } from "@/lib/wallet-client";

type Phase = { kind: "idle" } | { kind: "working"; text: string; walletId: string } | { kind: "error"; text: string };

export function WalletLogin({ next }: { next: string }) {
  const router = useRouter();
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    // Extensions inject window.cardano asynchronously; look again shortly after load.
    setWallets(listWallets());
    const t = setTimeout(() => setWallets(listWallets()), 800);
    return () => clearTimeout(t);
  }, []);

  async function signIn(walletId: string) {
    try {
      setPhase({ kind: "working", walletId, text: "Connecting to your wallet…" });
      const { api, addressHex } = await connectWallet(walletId);
      const challenge = await postJson<{ message: string; nonceToken: string }>("/api/auth/nonce", { address: addressHex });
      setPhase({ kind: "working", walletId, text: "Approve the sign-in message in your wallet. It costs nothing and moves no funds." });
      const sig = await signText(api, addressHex, challenge.message);
      setPhase({ kind: "working", walletId, text: "Signature received. Opening your dashboard…" });
      await postJson("/api/auth/verify", { nonceToken: challenge.nonceToken, ...sig });
      startRouteProgress();
      router.push(next);
    } catch (e) {
      setPhase({ kind: "error", text: walletErrorMessage(e) });
    }
  }

  if (wallets === null) {
    return (
      <div role="status" aria-label="Looking for wallets" className="flex gap-2">
        <Skeleton className="h-11 w-44" />
        <Skeleton className="h-11 w-44" />
      </div>
    );
  }
  if (wallets.length === 0) {
    return (
      <InlineError>
        No Cardano wallet found in this browser. Install Lace or Eternl, switch it to the Preprod test network, then reload this page.
      </InlineError>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        {wallets.map((w) => (
          <Button
            key={w.id}
            pending={phase.kind === "working" && phase.walletId === w.id}
            disabled={phase.kind === "working"}
            onClick={() => signIn(w.id)}
          >
            Sign in with {w.name}
          </Button>
        ))}
      </div>
      {phase.kind === "working" && (
        <InlineStatus busy>
          {phase.text} <Elapsed prefix=" " className="text-graphite" />
        </InlineStatus>
      )}
      {phase.kind === "error" && <InlineError>{phase.text}</InlineError>}
    </div>
  );
}
