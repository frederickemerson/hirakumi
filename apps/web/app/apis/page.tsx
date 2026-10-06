import Link from "next/link";
import { HealthBadge } from "@/components/health-badge";
import { EmptyState } from "@/components/states";
import { shortAddress } from "@/lib/copy";
import { getSql } from "@/lib/db";
import { requireSellerPage } from "@/lib/page-auth";
import { listApisForSeller } from "@/lib/repo/apis";

export default async function ApisPage() {
  const session = await requireSellerPage("/apis");
  const apis = await listApisForSeller(getSql(), session.sellerId);
  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your APIs</h1>
        <Link href="/apis/new" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Add an API</Link>
      </div>
      <p className="text-sm text-muted-foreground">Signed in as {shortAddress(session.addr)}. Buyers pay this address.</p>
      {apis.length === 0 ? (
        <EmptyState title="You haven't listed an API yet." detail="Add your first API with a link to its OpenAPI description." />
      ) : (
        <ul className="divide-y rounded-lg border">
          {apis.map((a) => (
            <li key={a.id} className="flex items-center justify-between p-4">
              <Link href={`/apis/${a.id}`} className="font-medium">{a.name}</Link>
              <HealthBadge state={a.state} health={a.health} checkedAt={a.healthCheckedAt} />
            </li>
          ))}
        </ul>
      )}
      <form action="/api/auth/logout" method="post">
        <button type="submit" className="text-sm underline">Sign out</button>
      </form>
    </section>
  );
}
