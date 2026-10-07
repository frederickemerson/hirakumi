"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Copies `value`; the label swaps to "Copied" in place (same width, no shift) and is announced politely. */
export function CopyButton({ value, label = "Copy", ariaLabel, variant = "outline" }: {
  value: string;
  label?: string;
  /** Names what is copied when several Copy buttons share a page ("Copy nginx snippet"). */
  ariaLabel?: string;
  /** "ghost" sits quietly in a toolbar, such as a code block's header. */
  variant?: "outline" | "ghost";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Button variant={variant} size="xs" onClick={copy} aria-label={ariaLabel} className="min-w-24">
      {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}
