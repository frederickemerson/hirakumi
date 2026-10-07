import Link from "next/link";
import { Mascot } from "@/components/brand/mascot";
import { ListApiLink } from "@/components/list-api-link";
import { tryHref } from "@/components/try-live-link";
import { DEMO_API_ID } from "@/lib/demo";

const DEMO_API = `/p/${DEMO_API_ID}`;

const columns = [
  {
    title: "Product",
    links: [
      { href: "/#how", label: "How it works" },
      { href: "/#trust", label: "How the money is protected" },
      { href: DEMO_API, label: "Live status page" },
      { href: tryHref(DEMO_API_ID), label: "Buy a real pack in your browser" },
      { href: "/login", label: "List your API", listApi: true },
    ],
  },
  {
    title: "Network",
    links: [
      { href: "https://preprod.sokosumi.com", label: "Sokosumi (preprod)", external: true },
      { href: "https://www.masumi.network", label: "Masumi network", external: true },
      { href: "https://preprod.cardanoscan.io", label: "Cardano preprod explorer", external: true },
    ],
  },
];

/** White footer, 1px ink top rule, multi-column links, 12px pencil copyright. */
export function SiteFooter() {
  return (
    <footer className="border-t border-ink bg-frost">
      <div className="mx-auto grid w-full max-w-[1200px] gap-10 px-4 py-14 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="space-y-4">
          <Link href="/" className="flex items-center gap-2.5 text-body-lg font-bold tracking-tight">
            <Mascot className="h-8" />
            <span>Hirakumi</span>
          </Link>
          <p className="max-w-xs text-body text-graphite">
            Monetize any API in under 3 minutes. You set a promise.
            AI agents pay only when you keep it.
          </p>
        </div>
        {columns.map((col) => (
          <nav key={col.title} aria-label={col.title} className="space-y-3">
            <h2 className="text-body font-semibold uppercase tracking-[0.04em]">{col.title}</h2>
            <ul className="space-y-2 text-body">
              {col.links.map((l) => (
                <li key={l.href}>
                  {"listApi" in l ? (
                    <ListApiLink className="underline-offset-4 hover:underline">{l.label}</ListApiLink>
                  ) : "external" in l && l.external ? (
                    <a href={l.href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                      {l.label}
                    </a>
                  ) : (
                    <Link href={l.href} className="underline-offset-4 hover:underline">
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-silver">
        <p className="mx-auto w-full max-w-[1200px] px-4 py-5 text-caption text-graphite">
          © 2026 Hirakumi. Built for TOKEN2049. Runs on the Cardano preprod test network with test funds only.
        </p>
      </div>
    </footer>
  );
}
