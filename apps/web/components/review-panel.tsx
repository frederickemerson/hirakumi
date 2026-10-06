"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson, RequestError } from "@/lib/client-fetch";
import { formatTusdm, parsePackCalls, parseTusdm, perCallTusdm } from "@/lib/money";
import type { Pack, RuleView } from "@/lib/types";

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "saved" } | { kind: "error"; text: string };

export function ReviewPanel({ apiId, state, promises, pack }: {
  apiId: string;
  state: "rule_built" | "priced";
  promises: RuleView[];
  pack: Pack | null;
}) {
  const router = useRouter();
  const [calls, setCalls] = useState(pack ? String(pack.calls) : "100");
  const [price, setPrice] = useState(pack ? formatTusdm(pack.priceMicros) : "2");
  const [escrow, setEscrow] = useState(pack ? formatTusdm(pack.escrowPriceMicros) : "2");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const perCall = useMemo(() => {
    try {
      return perCallTusdm(parseTusdm(price), parsePackCalls(calls));
    } catch {
      return null;
    }
  }, [price, calls]);

  async function run(action: () => Promise<void>) {
    setStatus({ kind: "busy" });
    try {
      await action();
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof RequestError ? e.message : "Something went wrong. Try again." });
    }
  }

  const save = () => run(async () => {
    await postJson(`/api/apis/${apiId}/pricing`, { packCalls: calls, packPrice: price, escrowPrice: escrow });
    setStatus({ kind: "saved" });
    router.refresh();
  });

  const publish = () => run(async () => {
    await postJson(`/api/apis/${apiId}/publish`, {});
    router.push(`/apis/${apiId}/overview`);
  });

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-lg font-medium">Your promise to buyers</h2>
        <p className="text-sm text-muted-foreground">
          A buyer's credit is used only when your response keeps this promise. Otherwise the call is free.
        </p>
        {promises.map((p) => (
          <div key={p.operationId} className="space-y-2 rounded-lg border p-4">
            <p className="font-mono text-sm">{p.method.toUpperCase()} {p.path}</p>
            <p>{p.plainEnglish ?? "The plain-English summary isn't ready yet. The exact check is below."}</p>
            <details>
              <summary className="cursor-pointer text-sm">Show the exact check (JSON)</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(p.definition, null, 2)}</pre>
              <p className="text-xs text-muted-foreground">Fingerprint: {p.hash}</p>
            </details>
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Price</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="pack-calls" className="text-sm font-medium">Calls per pack</label>
            <Input id="pack-calls" type="text" inputMode="numeric" value={calls} onChange={(e) => setCalls(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="pack-price" className="text-sm font-medium">Pack price (tUSDM)</label>
            <Input id="pack-price" type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="escrow-price" className="text-sm font-medium">Price per job hire (tUSDM)</label>
            <Input id="escrow-price" type="text" inputMode="decimal" value={escrow} onChange={(e) => setEscrow(e.target.value)} />
          </div>
        </div>
        {perCall && <p className="text-sm text-muted-foreground">About {perCall} tUSDM per call.</p>}
        <p className="text-sm text-muted-foreground">
          Pack payments go straight to your wallet. For per-job hires, Masumi holds the payment and keeps 5%.
        </p>
        <Button variant="outline" disabled={status.kind === "busy"} onClick={save}>Save price</Button>
        {status.kind === "saved" && <p role="status" className="text-sm text-green-700">Saved.</p>}
      </section>

      <section className="space-y-2">
        <Button disabled={state !== "priced" || status.kind === "busy"} onClick={publish}>Publish</Button>
        {state !== "priced" && <p className="text-sm text-muted-foreground">Save a price to publish.</p>}
        {status.kind === "error" && <p role="alert" className="text-sm text-destructive">{status.text}</p>}
      </section>
    </div>
  );
}
