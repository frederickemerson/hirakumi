"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function BuyerSnippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs"><code>{code}</code></pre>
      <Button variant="outline" onClick={copy}>{copied ? "Copied" : "Copy code"}</Button>
    </div>
  );
}
