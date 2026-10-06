import Link from "next/link";
import { Mascot } from "@/components/brand/mascot";

const DEMO_API = "/p/api_eejiaioyqt";

const columns = [
  {
    title: "Product",
    links: [
      { href: "/#how", label: "How it works" },
      { href: "/#trust", label: "Where the money sits" },
      { href: DEMO_API, label: "Live status page" },
      { href: `${DEMO_API}/try`, label: "Try a live API" },
      { href: "/login", label: "Put your API on the market" },
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
          <Link href="/" className="flex items-center gap-2 text-body-lg font-semibold">
            <Mascot className="h-8" />
            <span>Hirakumi</span>
          </Link>
          <p className="max-w-xs text-body text-graphite">
            開く <span className="text-ink">hiraku</span>, to open. Hirakumi puts your API on the AI-agent market on Cardano and
            charges buyers only for answers that keep your promise.
          </p>
        </div>
        {columns.map((col) => (
          <nav key={col.title} aria-label={col.title} className="space-y-3">
            <h2 className="text-body font-semibold uppercase tracking-[0.04em]">{col.title}</h2>
            <ul className="space-y-2 text-body">
              {col.links.map((l) => (
                <li key={l.href}>
                  {"external" in l && l.external ? (
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
