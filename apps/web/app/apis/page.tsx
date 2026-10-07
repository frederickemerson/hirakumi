import type { Metadata } from "next";
import Link from "next/link";
import { RefreshingDeleteApiButton } from "@/components/delete-api-button";
import { EmptyState } from "@/components/states";
import { StatusLight } from "@/components/status-light";
import { sellerTryHref, TryLiveLink } from "@/components/try-live-link";
import { buttonVariants } from "@/components/ui/button";
import { shortAddress } from "@/lib/copy";
import { getSql } from "@/lib/db";
import { requireSellerPage } from "@/lib/page-auth";
import { listApisForSeller, listRecordsKept, listStoppedApiIds } from "@/lib/repo/apis";
import { apiStatus } from "@/lib/status-labels";

export const metadata: Metadata = { title: "Your APIs" };

export default async function ApisPage() {
  const session = await requireSellerPage("/apis");
  const sql = getSql();
  const [apis, stopped, recordsKept] = await Promise.all([
    listApisForSeller(sql, session.sellerId), listStoppedApiIds(sql, session.sellerId), listRecordsKept(sql, session.sellerId),
  ]);
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-h font-medium uppercase">Your APIs</h1>
        <Link href="/apis/new" className={buttonVariants()}>Add an API</Link>
      </div>
      <p className="text-body text-graphite">
        Signed in as {shortAddress(session.addr)}. Buyers pay this address.{" "}
        <Link href="/account" className="underline underline-offset-4 hover:text-ink">Account settings</Link>
      </p>
      {apis.length === 0 ? (
        <EmptyState title="You haven't listed an API yet." detail="Add your first API with a link to its OpenAPI description." />
      ) : (
        <ul className="divide-y-2 divide-ink rounded-[2px] border-2 border-ink bg-frost">
          {apis.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <StatusLight tone={apiStatus(a.state, a.health, stopped.has(a.id)).tone} state={a.state} />
                <Link href={`/apis/${a.id}`} className="min-w-0 text-body-lg font-medium break-words underline-offset-4 hover:underline">{a.name}</Link>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <TryLiveLink apiId={a.id} state={a.state} health={a.health} variant="outline" size="sm" href={sellerTryHref(a.id)} />
                <RefreshingDeleteApiButton api={{ id: a.id, name: a.name, state: a.state, recordsKept: recordsKept.get(a.id) ?? null }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <form action="/api/auth/logout" method="post">
        <button type="submit" className="text-body underline underline-offset-4 hover:text-graphite">Log out</button>
      </form>
    </section>
  );
}