import Link from "next/link";
import { Mascot } from "@/components/brand/mascot";
import { HeaderAuth } from "@/components/header-auth";

const links = [
  { href: "/#how", label: "How it works" },
  { href: "/#trust", label: "Money" },
  { href: "/#proof", label: "Proof" },
  { href: "/#faq", label: "FAQ" },
];

/** White top bar, 1px ink rule: logo left, links centre, the signed-in or signed-out actions right. Not sticky. */
export function SiteHeader() {
  return (
    <header className="border-b border-ink bg-frost">
      <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between gap-4 px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 text-body-lg font-bold tracking-tight">
          <Mascot className="h-8" />
          <span>Hirakumi</span>
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-7 text-caption font-medium uppercase tracking-[0.06em] md:flex">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="py-2 underline-offset-4 transition-[text-decoration-color] duration-150 hover:underline">
              {l.label}
            </Link>
          ))}
        </nav>
        <HeaderAuth />
      </div>
    </header>
  );
}
