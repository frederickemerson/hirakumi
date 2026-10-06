"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button, buttonVariants } from "@/components/ui/button";

/** Something broke while rendering a page. The root layout (header, footer) stays. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <section className="mx-auto max-w-xl space-y-6 py-6 sm:py-12">
      <div role="alert" className="space-y-4 rounded-[2px] border-2 border-ink border-l-8 border-l-coral bg-frost p-6 sm:p-10">
        <h1 className="text-h font-medium uppercase">Something went wrong</h1>
        <p className="text-body-lg">This page didn&apos;t load. Try again, or go back home.</p>
        {error.digest && <p className="text-caption text-graphite">Reference: {error.digest}</p>}
        <div className="flex flex-wrap gap-3 pt-2">
          <Button onClick={() => reset()}>Try again</Button>
          <Link href="/" className={buttonVariants({ variant: "outline" })}>Go home</Link>
          <Link href="/apis" className={buttonVariants({ variant: "outline" })}>Go to your APIs</Link>
        </div>
      </div>
    </section>
  );
}
