import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { parse } from "tldts";
import { DirectCallerCard, FrontDoorWizard } from "@/components/front-door-wizard";
import { EmptyState } from "@/components/states";
import { getSql } from "@/lib/db";
import { stepForState } from "@/lib/flow";
import { getFrontDoorGateway, type FrontDoorView } from "@/lib/gateway";
import { loadApiPage } from "@/lib/page-auth";
import { getProvenCode } from "@/lib/repo/front-door";
import { hasAnyApiSchema, hasFrontDoorSchema, UPDATING } from "@/lib/repo/schema";
import { getUpstreamAuth } from "@/lib/repo/upstream-auth";
import type { ApiState } from "@/lib/types";
import { probeDns } from "../ownership/probe-dns";

export const metadata: Metadata = { title: "Protect your API" };

/** From proven ownership on: the address is final and the ownership code can be reused for a new origin. */
const READY: ReadonlySet<ApiState> = new Set(["ownership_verified", "rule_built", "priced", "registering", "live"]);

export default async function ProtectPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/protect`);
  if (!READY.has(api.state)) redirect(`/apis/${apiId}/${stepForState(api.state)}`);
  const sql = getSql();
  const heading = (
    <div className="space-y-3">
      <h1 className="text-h font-medium uppercase">Protect your API</h1>
      <p className="max-w-2xl text-body-lg">
        A monetized API is only reachable through Hirakumi. With the front door, your API&apos;s own hostname answers
        callers with Hirakumi&apos;s offer, and Hirakumi calls your server at a second hostname with your key.
      </p>
    </div>
  );
  if (!(await hasAnyApiSchema(sql)) || !(await hasFrontDoorSchema(sql))) {
    return <section className="space-y-6">{heading}<EmptyState title="Being updated" detail={UPDATING} /></section>;
  }
  const [view, code, key] = await Promise.all([
    getFrontDoorGateway().getFrontDoor(apiId).catch((): FrontDoorView | null => null),
    getProvenCode(sql, apiId),
    getUpstreamAuth(sql, apiId),
  ]);
  const publicHost = view?.publicHost ?? new URL(api.origin).hostname.toLowerCase().replace(/\.$/, "");
  const origin = view?.origin ?? api.origin;
  const apex = parse(publicHost).domain === publicHost;
  // Not awaited: the page renders now and the provider hint streams in.
  const dns = view?.domain ? probeDns(publicHost, publicHost) : undefined;
  return (
    <section className="space-y-6">
      {heading}
      <DirectCallerCard publicHost={publicHost} origin={origin} status={view?.domain?.status ?? null} hasKey={key !== null} />
      {!view && <EmptyState title="Can't reach Hirakumi's gateway" detail="The front door's status isn't available right now. Reload the page in a minute." />}
      {view && (
        <FrontDoorWizard
          apiId={apiId} publicHost={publicHost} origin={origin} code={code}
          domain={view.domain ? { status: view.domain.status, lastError: view.domain.lastError } : null}
          dnsTarget={view.dnsTarget} apex={apex} dns={dns}
          keyHint={key && !("parts" in key) ? { in: key.in, name: key.name } : null}
          keyParts={key && "parts" in key ? key.parts.map((x) => ({ in: x.in, name: x.name, fixed: !!x.fixed })) : null}
        />
      )}
      <p className="text-body">
        <Link href={`/apis/${apiId}/overview`} className="underline underline-offset-4">Back to your API</Link>
      </p>
    </section>
  );
}
