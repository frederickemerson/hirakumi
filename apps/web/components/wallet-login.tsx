"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/client-fetch";
import { connectWallet, listWallets, signText, walletErrorMessage, type WalletInfo } from "@/lib/wallet-client";

type Phase = { kind: "idle" } | { kind: "working"; text: string } | { kind: "error"; text: string };

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
      setPhase({ kind: "working", text: "Connecting to your wallet…" });
      const { api, addressHex } = await connectWallet(walletId);
      const challenge = await postJson<{ message: string; nonceToken: string }>("/api/auth/nonce", { address: addressHex });
      setPhase({ kind: "working", text: "Approve the sign-in message in your wallet. It costs nothing and moves no funds." });
      const sig = await signText(api, addressHex, challenge.message);
      await postJson("/api/auth/verify", { nonceToken: challenge.nonceToken, ...sig });
      router.push(next);
    } catch (e) {
      setPhase({ kind: "error", text: walletErrorMessage(e) });
    }
  }

  if (wallets === null) return null;
  if (wallets.length === 0) {
    return (
      <p role="alert" className="text-sm">
        No Cardano wallet found in this browser. Install Eternl, switch it to the preprod test network, then reload this page.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {wallets.map((w) => (
          <Button key={w.id} disabled={phase.kind === "working"} onClick={() => signIn(w.id)}>
            Sign in with {w.name}
          </Button>
        ))}
      </div>
      {phase.kind === "working" && <p role="status" className="text-sm text-muted-foreground">{phase.text}</p>}
      {phase.kind === "error" && <p role="alert" className="text-sm text-destructive">{phase.text}</p>}
    </div>
  );
}
