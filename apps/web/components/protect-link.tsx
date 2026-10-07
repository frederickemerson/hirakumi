import Link from "next/link";
import { DOMAIN_STATUS_LABEL } from "@/lib/front-door";
import type { DomainStatus } from "@/lib/gateway";

/** The way into the protect page, with the front door's status when it is in use. */
export function ProtectLink({ apiId, frontDoor }: { apiId: string; frontDoor: { host: string; status: DomainStatus } | null }) {
  return (
    <section aria-labelledby={`protect-${apiId}`} className="space-y-2 rounded-[2px] border-2 border-ink bg-frost p-5">
      <h2 id={`protect-${apiId}`} className="text-body-lg font-semibold">Protect your API</h2>
      <p className="text-body">
        {frontDoor
          ? `Front door on ${frontDoor.host}: ${DOMAIN_STATUS_LABEL[frontDoor.status]}.`
          : "Make your API reachable only through Hirakumi: your own hostname answers with Hirakumi's offer, and Hirakumi calls your server with a key."}
      </p>
      <Link href={`/apis/${apiId}/protect`} className="text-body underline underline-offset-4">
        {frontDoor ? "Manage the front door" : "Set up the front door"}
      </Link>
    </section>
  );
}
