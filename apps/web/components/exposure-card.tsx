"use client";

import { useState } from "react";
import { InlineError, InlineStatus } from "@/components/states";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";
import { cn } from "@/lib/utils";

export type ExposureValue = "open" | "protected" | "unknown";
/** What the card shows: the stored result (no message), or a fresh check's result with its message. */
export type ExposureState = { exposure: ExposureValue; checkedAt: string | null; message?: string | null };

/** The id of the key form's wrapper on the review page, so the card can point to it. */
export const KEY_FORM_ID = "api-key";

const OPEN_TEXT =
  "Anyone can call your API for free without its key, so nobody would pay through Hirakumi. " +
  "Make your API require a key and add it on this page. Publishing waits until then.";
const PROTECTED_TEXT = "Your API refuses calls without its key, so only buyers who pay through Hirakumi get answers.";
const UNKNOWN_TEXT =
  "Before publishing, Hirakumi calls each endpoint once without your key, to make sure nobody can get its answers for free.";
const UNSETTLED_TEXT = "The last check couldn't tell whether every endpoint refuses calls without your key. Check again before publishing.";

/** "2026-10-07 17:20 UTC": the same on the server and in the browser, so rendering never differs between them. */
export const checkedLabel = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * The leak check on the review page (lib/exposure.ts): publishing needs every endpoint to refuse calls without the
 * seller's key. Shows the last result and runs it again on "Check again".
 */
export function ExposureCard({ apiId, initial }: { apiId: string; initial: ExposureState | null }) {
  const [state, setState] = useState<ExposureState>(initial ?? { exposure: "unknown", checkedAt: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ exposure: ExposureValue; checkedAt: string; message: string | null }>(`/api/apis/${apiId}/exposure`, {});
      setState({ exposure: r.exposure, checkedAt: r.checkedAt, message: r.message });
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const neverChecked = state.checkedAt === null;
  const text = state.message ?? (state.exposure === "open" ? OPEN_TEXT : state.exposure === "protected" ? PROTECTED_TEXT
    : neverChecked ? UNKNOWN_TEXT : UNSETTLED_TEXT);
  return (
    <section
      aria-labelledby={`exposure-${apiId}`}
      data-testid="exposure-card"
      data-exposure={state.exposure}
      className={cn(
        "space-y-3 rounded-[2px] border-2 border-ink bg-frost p-5",
        state.exposure === "open" && "border-l-8 border-l-coral",
        state.exposure === "protected" && "border-l-8 border-l-mint",
      )}
    >
      <h2 id={`exposure-${apiId}`} className="text-body-lg font-semibold">Only buyers can call it</h2>
      <p className="text-body" data-testid="exposure-text">{text}</p>
      {state.exposure === "open" && (
        <p className="text-body"><a className="underline" href={`#${KEY_FORM_ID}`}>Add your API&apos;s key</a></p>
      )}
      {state.checkedAt && (
        <p className="text-caption text-graphite">Checked {checkedLabel(state.checkedAt)}</p>
      )}
      <Button variant="outline" size="sm" disabled={busy} pending={busy} pendingLabel="Checking…" onClick={() => void check()}>
        {neverChecked ? "Check now" : "Check again"}
      </Button>
      {busy && <InlineStatus busy>Calling each endpoint without your key</InlineStatus>}
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
}
