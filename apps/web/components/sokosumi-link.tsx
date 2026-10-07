"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { InlineError } from "@/components/states";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";
import { shortAddress } from "@/lib/copy";

const panel = "space-y-3 rounded-[2px] border-2 border-ink bg-frost p-4 text-body";

/** Before the first submit from a setup link: say plainly what the submit links, and to which wallet. */
export function SokosumiLinkNotice({ address }: { address: string }) {
  return (
    <div data-testid="sokosumi-link-notice" className={panel}>
      <p>
        This links your Sokosumi account to this wallet (<code>{shortAddress(address)}</code>). Listings from your
        Sokosumi tasks will belong to it.
      </p>
    </div>
  );
}

/** The Sokosumi account is already linked to this wallet. */
export function SokosumiLinkedHere({ address }: { address: string }) {
  return (
    <div data-testid="sokosumi-linked-here" className={panel}>
      <p>Your Sokosumi account is already linked to this wallet (<code>{shortAddress(address)}</code>).</p>
    </div>
  );
}

/** This wallet holds a different Sokosumi account: it has to be unlinked first. */
export function SokosumiLinkConflict() {
  return (
    <div role="alert" data-testid="sokosumi-link-conflict" className={panel}>
      <p>This wallet is already linked to another Sokosumi account. Unlink it in <a href="/account" className="underline underline-offset-4">Account settings</a> first, then open this link again.</p>
    </div>
  );
}

/**
 * Linking (from null) or moving (from: the wallet that holds it now) the Sokosumi account to this wallet takes an
 * explicit confirm.
 */
export function MoveSokosumiPanel({ setupToken, from, to }: { setupToken: string; from: string | null; to: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/sokosumi/link", { setupToken });
      setDone(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status" data-testid="sokosumi-moved" className={panel}>
        <p>Your Sokosumi account now uses this wallet (<code>{shortAddress(to)}</code>).</p>
      </div>
    );
  }
  return (
    <div data-testid="sokosumi-move" className={panel}>
      <h2 className="text-sub font-medium uppercase">{from ? "Move your Sokosumi account" : "Link your Sokosumi account"}</h2>
      {from ? (
        <p>
          Your Sokosumi account is linked to wallet <code>{shortAddress(from)}</code>. Move it to this wallet
          (<code>{shortAddress(to)}</code>)? Listings from your Sokosumi tasks that are not live yet move with it.
        </p>
      ) : (
        <p>
          This links your Sokosumi account to this wallet (<code>{shortAddress(to)}</code>). Listings from your
          Sokosumi tasks will belong to it.
        </p>
      )}
      {error && <InlineError>{error}</InlineError>}
      <Button type="button" onClick={confirm} pending={busy} pendingLabel="Moving…">Confirm</Button>
    </div>
  );
}

/** Account settings: whether a Sokosumi account is linked, with Unlink. Listings stay with this wallet. */
export function SokosumiAccountLink({ linked: initial }: { linked: boolean }) {
  const router = useRouter();
  const [linked, setLinked] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/sokosumi/unlink", {});
      setLinked(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="sokosumi-account" className="flex min-w-0 flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span>{linked ? "Linked" : "Not linked"}</span>
        {linked && (
          <Button type="button" variant="outline" size="sm" onClick={unlink} pending={busy} pendingLabel="Unlinking…">Unlink</Button>
        )}
      </div>
      {linked && <p className="text-caption text-graphite">Unlinking keeps your listings on this wallet.</p>}
      {error && <InlineError>{error}</InlineError>}
    </div>
  );
}
