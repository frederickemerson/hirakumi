"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function BuyerSnippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="rounded-[2px] border-2 border-ink bg-frost">
      <div className="flex items-center justify-between gap-4 border-b-2 border-ink px-4 py-2">
        <span className="text-caption font-semibold uppercase tracking-[0.04em]">Buyer code</span>
        <Button variant="outline" size="xs" onClick={copy} aria-live="polite">{copied ? "Copied" : "Copy code"}</Button>
      </div>
      <pre className="overflow-x-auto bg-ink p-4 text-caption leading-relaxed text-cream"><code>{code}</code></pre>
    </div>
  );
}
