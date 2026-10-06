"use client";

import { useEffect, useRef, useState } from "react";
import { InlineError, InlineStatus } from "@/components/states";
import { Button } from "@/components/ui/button";

/** Fired on window when a phone wallet's CIP-30 API appears in or leaves window.cardano. */
export const WALLETS_CHANGED = "hirakumi:wallets-changed";

type PeerConnect = { generateQRCode(el: HTMLElement): void; getAddress(): string; destroy(): void };

type State =
  | { kind: "closed" }
  | { kind: "starting" }
  | { kind: "waiting" }
  | { kind: "connected"; walletId: string }
  | { kind: "error"; text: string };

/**
 * CIP-45 (Cardano Peer Connect): the page shows a QR code, a phone wallet such as Eternl scans it, and
 * the phone's wallet appears here as a normal CIP-30 wallet in window.cardano. Signing still happens
 * on the phone; this page never sees keys.
 */
export function PhoneWalletConnect({ onConnected }: { onConnected?: (walletId: string) => void }) {
  const [state, setState] = useState<State>({ kind: "closed" });
  const qr = useRef<HTMLDivElement>(null);
  const peer = useRef<PeerConnect | null>(null);
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;

  useEffect(() => () => peer.current?.destroy(), []);

  async function open() {
    setState({ kind: "starting" });
    try {
      const { DAppPeerConnect } = await import("@fabianbormann/cardano-peer-connect");
      const changed = () => window.dispatchEvent(new Event(WALLETS_CHANGED));
      const p = new DAppPeerConnect({
        dAppInfo: { name: "Hirakumi", url: window.location.origin },
        // The user scanned our code on purpose, so accept; signing still asks on the phone.
        verifyConnection: (_wallet: unknown, callback: (granted: boolean, autoConnect: boolean) => void) => callback(true, false),
        onApiInject: (walletId: string) => {
          changed();
          setState({ kind: "connected", walletId });
          connectedRef.current?.(walletId);
        },
        onApiEject: () => {
          changed();
          setState({ kind: "waiting" });
        },
      }) as unknown as PeerConnect;
      peer.current = p;
      setState({ kind: "waiting" });
      // The QR container renders once state is "waiting"; draw into it on the next frame.
      requestAnimationFrame(() => {
        if (qr.current) p.generateQRCode(qr.current);
      });
    } catch {
      setState({ kind: "error", text: "Couldn't start the phone connection. Reload the page and try again." });
    }
  }

  if (state.kind === "closed") {
    return (
      <Button variant="ghost" className="w-full" onClick={() => void open()}>
        Use a wallet on your phone
      </Button>
    );
  }
  return (
    <div className="space-y-3 rounded-[2px] border-2 border-ink bg-frost p-4">
      <p className="font-medium">Scan with your phone wallet</p>
      <p className="text-body text-graphite">
        Open a wallet that supports Cardano Peer Connect (for example Eternl), choose connect to a dApp, and scan this code. Keep this page open.
      </p>
      {(state.kind === "waiting" || state.kind === "starting") && (
        <div
          ref={qr}
          aria-label="QR code for your phone wallet"
          role="img"
          className="mx-auto aspect-square w-56 bg-white [&_svg]:h-full [&_svg]:w-full"
        />
      )}
      {state.kind === "starting" && <InlineStatus busy>Preparing the code…</InlineStatus>}
      {state.kind === "waiting" && <InlineStatus busy>Waiting for your phone…</InlineStatus>}
      {state.kind === "connected" && <InlineStatus>Phone wallet connected. Approve the request on your phone.</InlineStatus>}
      {state.kind === "error" && <InlineError>{state.text}</InlineError>}
    </div>
  );
}
