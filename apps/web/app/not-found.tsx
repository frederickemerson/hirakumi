import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = { title: "Not found" };

/** Any unknown page or id. The header and footer come from the root layout. */
export default function NotFound() {
  return (
    <section className="mx-auto max-w-xl space-y-6 py-6 sm:py-12">
      <div className="space-y-4 rounded-[2px] border-2 border-ink bg-frost p-6 shadow-hard sm:p-10">
        <p className="text-caption font-semibold uppercase tracking-[0.06em] text-graphite">404</p>
        <h1 className="text-h font-medium uppercase">We couldn&apos;t find that page</h1>
        <p className="text-body-lg">The link may be wrong, or the API is not live.</p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link href="/" className={buttonVariants()}>Go home</Link>
          <Link href="/apis" className={buttonVariants({ variant: "outline" })}>Go to your APIs</Link>
        </div>
      </div>
    </section>
  );
}
