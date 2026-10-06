import Link from "next/link";

export function ApiNav({ apiId }: { apiId: string }) {
  const links = [
    { href: `/apis/${apiId}`, label: "Listing steps" },
    { href: `/apis/${apiId}/overview`, label: "Overview" },
    { href: `/apis/${apiId}/sales`, label: "Sales" },
  ];
  return (
    <nav className="flex gap-4 border-b pb-2 text-sm">
      <Link href="/apis" className="text-muted-foreground">All APIs</Link>
      {links.map((l) => (
        <Link key={l.href} href={l.href}>{l.label}</Link>
      ))}
    </nav>
  );
}
