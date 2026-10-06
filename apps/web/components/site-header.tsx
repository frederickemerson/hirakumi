import Link from "next/link";
import { Mascot } from "@/components/brand/mascot";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const links = [
  { href: "/#how", label: "How it works" },
  { href: "/#buy", label: "Buying" },
  { href: "/#status", label: "Status" },
  { href: "/#faq", label: "FAQ" },
];

/** White top bar, 1px ink rule: logo left, links centre, log in + CTA right. Not sticky. */
export function SiteHeader() {
  return (
    <header className="border-b border-ink bg-frost">
      <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between gap-4 px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2 text-body-lg font-semibold">
          <Mascot className="h-8" />
          <span>Hirakumi</span>
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-7 text-caption font-medium uppercase tracking-[0.06em] md:flex">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="py-2 hover:underline hover:underline-offset-4">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <Link href="/apis" className="hidden py-2 text-caption font-medium uppercase tracking-[0.06em] hover:underline hover:underline-offset-4 sm:inline">
            Log in
          </Link>
          <Link href="/login" className={cn(buttonVariants({ variant: "nav", size: "sm" }), "min-h-9")}>
            <span className="sm:hidden">List your API</span>
            <span className="hidden sm:inline">Put your API on the market</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
