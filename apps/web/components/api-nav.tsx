"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const STEP_PAGE = /\/(endpoints|ownership|review)$/;

/**
 * Tab strip for one API's pages. The current tab is filled ink, like the product frame's tabs.
 * "Listing steps" links straight to the current step's page: the one being viewed, or the one the
 * layout worked out from the API's state. stepHref is null once the API is live or retired: no tab then.
 * "Try it live" (the seller testing their own API) shows while the API is live.
 */
export function ApiNav({ apiId, stepHref, live = false }: { apiId: string; stepHref: string | null; live?: boolean }) {
  const pathname = usePathname();
  const onStep = STEP_PAGE.test(pathname);
  const links = [
    ...(stepHref === null
      ? []
      : [{ href: onStep ? pathname : stepHref, label: "Listing steps", active: onStep || pathname === `/apis/${apiId}` }]),
    { href: `/apis/${apiId}/overview`, label: "Overview", active: pathname.endsWith("/overview") },
    { href: `/apis/${apiId}/sales`, label: "Sales", active: pathname.endsWith("/sales") },
    // The seller's own Try it live, for a live API only.
    ...(live ? [{ href: `/apis/${apiId}/try`, label: "Try it live", active: pathname.endsWith("/try") }] : []),
  ];
  return (
    <nav aria-label="This API" className="flex flex-wrap items-center gap-x-6 gap-y-3 text-caption font-semibold uppercase tracking-[0.04em]">
      <Link href="/apis" className="py-2 text-graphite hover:text-ink hover:underline hover:underline-offset-4">← All APIs</Link>
      <ol className="flex overflow-x-auto rounded-[2px] border-2 border-ink bg-frost">
        {links.map((l) => (
          <li key={l.label} className="border-r-2 border-ink last:border-r-0">
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
