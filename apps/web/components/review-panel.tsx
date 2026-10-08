"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Elapsed } from "@/components/elapsed";
import { InlineError, InlineStatus } from "@/components/states";
import { toast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isTextPromise, promiseFormatNote, statusOnlyRefusal, WHY_PHRASE } from "@/lib/answer-format";
import { postJson, RequestError } from "@/lib/client-fetch";
import { formatTusdm, parsePackCalls, parseTusdm, perCallTusdm } from "@/lib/money";
import { startRouteProgress } from "@/lib/route-progress";
import type { Pack, RuleView } from "@/lib/types";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "publishing"; text: string } | { kind: "error"; text: string };

/**
 * The last onboarding step: read the promise, set the price, publish. "Publish at this price" saves
 * the price as typed and publishes in one click; "Save price" only saves. Publishing waits until every
 * status-only text promise has a phrase (the publish route refuses it too).
 */
export function ReviewPanel({ apiId, promises, pack, suggestedPhrases = {} }: {
  apiId: string;
  state: "rule_built" | "priced";
  promises: RuleView[];
  pack: Pack | null;
  /** QA's suggested phrase for a status-only text promise, by operation id (lib/repo/rules getSuggestedPhrases). */
  suggestedPhrases?: Record<string, string>;
}) {
  const router = useRouter();
  const [calls, setCalls] = useState(pack ? String(pack.calls) : "100");
  const [price, setPrice] = useState(pack ? formatTusdm(pack.priceMicros) : "2");
  const [escrow, setEscrow] = useState(pack ? formatTusdm(pack.escrowPriceMicros) : "2");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "saving" || status.kind === "publishing";
  const needsPhrase = statusOnlyRefusal(promises);

  const perCall = useMemo(() => {
    try {
      return perCallTusdm(parseTusdm(price), parsePackCalls(calls));
    } catch {
      return null;
    }
  }, [price, calls]);

  async function run(first: Status, action: () => Promise<void>) {
    setStatus(first);
    try {
      await action();
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof RequestError ? e.message : "Something went wrong. Try again." });
    }
  }

  const savePrice = () => postJson(`/api/apis/${apiId}/pricing`, { packCalls: calls, packPrice: price, escrowPrice: escrow });

  const save = () => run({ kind: "saving" }, async () => {
    await savePrice();
    setStatus({ kind: "idle" });
    toast("Price saved");
    router.refresh();
  });

  const publishAtThisPrice = () => run({ kind: "publishing", text: "Saving the price" }, async () => {
    await savePrice();
    setStatus({ kind: "publishing", text: "Registering your API on Masumi" });
    await postJson(`/api/apis/${apiId}/publish`, {});
    startRouteProgress();
    router.push(`/apis/${apiId}/overview`);
  });

  return (
    <div className="space-y-8" aria-busy={busy || undefined}>
      <section className="space-y-4">
        <h2 className="text-sub font-semibold uppercase">Your promise to buyers</h2>
        <p className="text-body-lg">
          A buyer&apos;s credit is used only when your response keeps this promise. Otherwise the call is free.
        </p>
        {promises.map((p) => (
          <div key={p.operationId} className="space-y-3 rounded-[2px] border-2 border-ink bg-frost p-5">
            <p className="flex items-center gap-2 text-body-lg"><Badge variant="sky">{p.method.toUpperCase()}</Badge><code>{p.path}</code></p>
            <p className="text-body-lg">{p.plainEnglish ?? "The plain-English summary isn't ready yet. The exact check is below."}</p>
            {promiseFormatNote(p.definition) && <p className="text-body text-graphite">{promiseFormatNote(p.definition)}</p>}
            {isTextPromise(p.definition) && <PhraseField apiId={apiId} promise={p} suggestion={suggestedPhrases[p.operationId] ?? ""} disabled={busy} />}
            <details className="group">
              <summary className="cursor-pointer text-body underline underline-offset-4">Show the exact check (JSON)</summary>
              <pre className="mt-3 overflow-x-auto rounded-[2px] bg-ink p-3 text-caption text-cream">{JSON.stringify(p.definition, null, 2)}</pre>
              <p className="mt-2 text-caption text-graphite">Fingerprint: {p.hash}</p>
            </details>
          </div>
        ))}
      </section>

      <section className="space-y-4 rounded-[2px] border-2 border-ink bg-frost p-5 sm:p-6">
        <h2 className="text-sub font-semibold uppercase">Price</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <label htmlFor="pack-calls" className="block text-body font-medium">Calls per pack</label>
            <Input id="pack-calls" type="text" inputMode="numeric" value={calls} onChange={(e) => setCalls(e.target.value)} disabled={busy} />
          </div>
          <div className="space-y-2">
            <label htmlFor="pack-price" className="block text-body font-medium">Pack price (tUSDM)</label>
            <Input id="pack-price" type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} disabled={busy} />
          </div>
          <div className="space-y-2">
            <label htmlFor="escrow-price" className="block text-body font-medium">Price per job hire (tUSDM)</label>
            <Input id="escrow-price" type="text" inputMode="decimal" value={escrow} onChange={(e) => setEscrow(e.target.value)} disabled={busy} />
          </div>
        </div>
        {perCall && <p className="text-body">About {perCall} tUSDM per call.</p>}
        <p className="text-body text-graphite">
          Pack money locks in an escrow contract: you are paid per signed call when the pack settles, less Hirakumi's 3%, and the buyer gets back the rest. For per-job hires, Masumi holds the payment and keeps 5%.
        </p>
        <div className="flex flex-col gap-4 border-t border-ink pt-5 sm:flex-row sm:items-center">
          <Button disabled={busy || needsPhrase !== null} pending={status.kind === "publishing"} pendingLabel="Publishing…" onClick={publishAtThisPrice}>
            Publish at this price
          </Button>
          <Button variant="outline" disabled={busy} pending={status.kind === "saving"} pendingLabel="Saving…" onClick={save}>
            Save price
          </Button>
        </div>
        {needsPhrase && <p className="text-body" data-testid="publish-needs-phrase">{needsPhrase}</p>}
        {status.kind === "publishing" && (
          <InlineStatus busy>
            {status.text} <Elapsed prefix=" " className="text-graphite" />
          </InlineStatus>
        )}
        {status.kind === "error" && <InlineError>{status.text}</InlineError>}
      </section>
    </div>
  );
}

export const STATUS_ONLY_NOTICE =
  `This promise only checks the status. Add a phrase every good answer contains before you publish. ${WHY_PHRASE}`;
const NO_SUGGESTION_HINT = "Type a word or label every good answer contains, like Price or Symbol. Capital letters don't matter.";
const SUGGESTION_HINT =
  "We found this in every good test answer and not in the answer to a wrong request. Keep it only if every answer will always contain it: not a date, a version or a count.";

/**
 * "Every good answer contains": a phrase for a text promise. Saving it makes a new promise version
 * (POST /api/apis/[apiId]/promise-phrase); the page then shows the new promise. Required for a status-only
 * promise, prefilled with QA's suggestion when there is one; optional otherwise.
 */
function PhraseField({ apiId, promise, suggestion, disabled }: { apiId: string; promise: RuleView; suggestion: string; disabled: boolean }) {
  const router = useRouter();
  const required = promise.statusOnly;
  const [phrase, setPhrase] = useState(required ? suggestion : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `phrase-${promise.operationId}`;
  const hintId = `${id}-hint`;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postJson(`/api/apis/${apiId}/promise-phrase`, { operationId: promise.operationId, phrase });
      setPhrase("");
      toast("Promise updated");
      router.refresh();
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-2 border-t border-ink pt-3" aria-busy={saving || undefined}>
      {required && <p className="text-body" data-testid="status-only-notice">{STATUS_ONLY_NOTICE}</p>}
      {promise.requiredPhrases.length > 0 && (
        <p className="text-body text-graphite">Every good answer contains: {promise.requiredPhrases.map((t) => `"${t}"`).join(", ")}</p>
      )}
      <label htmlFor={id} className="block text-body font-medium">
        {required ? "Every good answer contains (required)" : "Every good answer contains (optional)"}
      </label>
      {required && <p id={hintId} className="text-body text-graphite">{suggestion ? SUGGESTION_HINT : NO_SUGGESTION_HINT}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input id={id} type="text" maxLength={200} value={phrase} onChange={(e) => setPhrase(e.target.value)} disabled={disabled || saving}
          required={required} aria-describedby={required ? hintId : undefined} />
        <Button type="submit" variant="outline" disabled={disabled || saving || !phrase.trim()} pending={saving} pendingLabel="Saving…">
          Add phrase
        </Button>
      </div>
      {error && <InlineError>{error}</InlineError>}
    </form>
  );
}
