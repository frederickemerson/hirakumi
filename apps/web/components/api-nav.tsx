"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Tab strip for one API's pages. The current tab is filled ink, like the product frame's tabs. */
export function ApiNav({ apiId }: { apiId: string }) {
  const pathname = usePathname();
  const links = [
    { href: `/apis/${apiId}`, label: "Listing steps", active: /\/(endpoints|ownership|review)$/.test(pathname) || pathname === `/apis/${apiId}` },
    { href: `/apis/${apiId}/overview`, label: "Overview", active: pathname.endsWith("/overview") },
    { href: `/apis/${apiId}/sales`, label: "Sales", active: pathname.endsWith("/sales") },
  ];
  return (
    <nav aria-label="This API" className="flex flex-wrap items-center gap-x-6 gap-y-3 text-caption font-semibold uppercase tracking-[0.04em]">
      <Link href="/apis" className="py-2 text-graphite hover:text-ink hover:underline hover:underline-offset-4">← All APIs</Link>
      <ol className="flex overflow-x-auto rounded-[2px] border-2 border-ink bg-frost">
        {links.map((l) => (
          <li key={l.href} className="border-r-2 border-ink last:border-r-0">
            <Link
              href={l.href}
              aria-current={l.active ? "page" : undefined}
              className={cn("block px-4 py-2 whitespace-nowrap transition-colors", l.active ? "bg-ink text-cream" : "hover:bg-ice")}
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
