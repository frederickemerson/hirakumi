import Link from "next/link";
import { HealthBadge } from "@/components/health-badge";
import { EmptyState } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import { shortAddress } from "@/lib/copy";
import { getSql } from "@/lib/db";
import { requireSellerPage } from "@/lib/page-auth";
import { listApisForSeller } from "@/lib/repo/apis";

export default async function ApisPage() {
  const session = await requireSellerPage("/apis");
  const apis = await listApisForSeller(getSql(), session.sellerId);
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-h font-medium uppercase">Your APIs</h1>
        <Link href="/apis/new" className={buttonVariants()}>Add an API</Link>
      </div>
      <p className="text-body text-graphite">Signed in as {shortAddress(session.addr)}. Buyers pay this address.</p>
      {apis.length === 0 ? (
        <EmptyState title="You haven't listed an API yet." detail="Add your first API with a link to its OpenAPI description." />
      ) : (
        <ul className="divide-y-2 divide-ink rounded-[2px] border-2 border-ink bg-frost">
          {apis.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <Link href={`/apis/${a.id}`} className="text-body-lg font-medium underline-offset-4 hover:underline">{a.name}</Link>
              <HealthBadge state={a.state} health={a.health} checkedAt={a.healthCheckedAt} />
            </li>
          ))}
        </ul>
      )}
      <form action="/api/auth/logout" method="post">
        <button type="submit" className="text-body underline underline-offset-4 hover:text-graphite">Sign out</button>
      </form>
    </section>
  );
}
