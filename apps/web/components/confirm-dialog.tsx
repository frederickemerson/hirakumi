"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { InlineError } from "@/components/states";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RequestError } from "@/lib/client-fetch";
import { cn } from "@/lib/utils";

type Props = {
  triggerLabel: string;
  triggerVariant?: "outline" | "destructive" | "ghost";
  triggerSize?: "xs" | "sm" | "default";
  triggerClassName?: string;
  title: string;
  /** One or two sentences: what happens. Read out as the dialog's description. */
  description: string;
  /** Optional detail under the description (a list of what goes). */
  details?: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  /** When set, the seller must type this exactly before the confirm button works. */
  typeToConfirm?: string;
  /** Throw a RequestError to show its message in the dialog; resolve to close it. */
  onConfirm: () => Promise<void>;
};

/**
 * A modal confirmation for destructive actions. Base UI's alert dialog traps focus, closes on Esc and returns
 * focus to the trigger. While the request runs the dialog can't be dismissed, so the outcome is never lost.
 */
export function ConfirmDialog({
  triggerLabel, triggerVariant = "outline", triggerSize = "xs", triggerClassName, title, description, details,
  confirmLabel, pendingLabel, typeToConfirm, onConfirm,
}: Props) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = typeToConfirm === undefined || typed === typeToConfirm;

  function onOpenChange(next: boolean) {
    if (pending && !next) return;
    setOpen(next);
    if (next) {
      setTyped("");
      setError(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setPending(false);
      setOpen(false);
    } catch (err) {
      setPending(false);
      setError(err instanceof RequestError ? err.message : "Something went wrong. Try again.");
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger className={cn(buttonVariants({ variant: triggerVariant, size: triggerSize }), triggerClassName)}>
        {triggerLabel}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-ink/40 transition-opacity duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <AlertDialog.Popup
          initialFocus={typeToConfirm !== undefined ? inputRef : cancelRef}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[2px] border-2 border-ink bg-frost p-5 shadow-hard transition-[opacity,scale] duration-150 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 motion-reduce:transition-none sm:p-6"
        >
          <form onSubmit={submit} className="space-y-4">
            <AlertDialog.Title className="text-body-lg font-medium break-words">{title}</AlertDialog.Title>
            <AlertDialog.Description className="text-body">{description}</AlertDialog.Description>
            {details}
            {typeToConfirm !== undefined && (
              <div className="space-y-2">
                <label htmlFor={inputId} className="block text-caption">
                  Type <span className="font-semibold break-all">{typeToConfirm}</span> to confirm
                </label>
                <Input
                  ref={inputRef}
                  id={inputId}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={pending}
                />
              </div>
            )}
            {error && <InlineError>{error}</InlineError>}
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <AlertDialog.Close ref={cancelRef} disabled={pending} className={buttonVariants({ variant: "outline" })}>
                Cancel
              </AlertDialog.Close>
              <Button type="submit" variant="destructive" disabled={!ready} pending={pending} pendingLabel={pendingLabel}>
                {confirmLabel}
              </Button>
            </div>
          </form>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
