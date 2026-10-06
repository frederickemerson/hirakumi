import type { Metadata } from "next";
import Link from "next/link";
import { HealthBadge } from "@/components/health-badge";
import { EmptyState } from "@/components/states";
import { TryLiveLink } from "@/components/try-live-link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { shortAddress, STATE_LABEL } from "@/lib/copy";
import { getSql } from "@/lib/db";
import { requireSellerPage } from "@/lib/page-auth";
import { listApisForSeller, listStoppedApiIds } from "@/lib/repo/apis";
import { apiStatus, STATUS_BADGE_VARIANT } from "@/lib/status-labels";
import type { Api } from "@/lib/types";

export const metadata: Metadata = { title: "Your APIs" };

export default async function ApisPage() {
  const session = await requireSellerPage("/apis");
  const sql = getSql();
  const [apis, stopped] = await Promise.all([listApisForSeller(sql, session.sellerId), listStoppedApiIds(sql, session.sellerId)]);
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
              <Link href={`/apis/${a.id}`} className="text-body-lg font-medium underline-offset-4 hover:underline">{a.name}</Link>
              <div className="flex flex-wrap items-center gap-3">
                {a.state === "live" ? (
                  <HealthBadge state={a.state} health={a.health} checkedAt={a.healthCheckedAt} />
                ) : (
                  <ApiStatusBadge state={a.state} health={a.health} stopped={stopped.has(a.id)} />
                )}
                <TryLiveLink apiId={a.id} state={a.state} health={a.health} variant="outline" size="sm" />
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

/** The same label /account shows (lib/status-labels), with where the API stands while it is being listed. */
function ApiStatusBadge({ state, health, stopped }: { state: Api["state"]; health: Api["health"]; stopped: boolean }) {
  const status = apiStatus(state, health, stopped);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge variant={STATUS_BADGE_VARIANT[status.tone]}>{status.label}</Badge>
      {state !== "retired" && <span className="text-caption text-graphite">{STATE_LABEL[state]}</span>}
    </span>
  );
}
