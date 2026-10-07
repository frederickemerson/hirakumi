/* Client-safe: the protect page, the retire and delete dialogs and their routes share these words. */

import type { DomainStatus } from "./gateway";

/** What the seller undoes on their side once Hirakumi stops selling the API. Empty when there is nothing. */
export function undoSteps(a: { frontDoorHost: string | null; hadKey: boolean }): string[] {
  const steps: string[] = [];
  if (a.frontDoorHost) {
    steps.push(
      `Point ${a.frontDoorHost} back at your own server: replace the CNAME (or A record) to Hirakumi with the record it had before. Until then, callers there get an error from Hirakumi.`,
    );
  }
  if (a.hadKey) {
    steps.push("Your API still asks for the key you gave Hirakumi. Remove that check if you want anyone to call it directly again.");
  }
  return steps;
}

/** The chat message that keeps the steps after the dialog closes. */
export function undoMessage(name: string, steps: string[]): string {
  return `${name} is no longer sold through Hirakumi. To open it up again on your side: ${steps.map((s, i) => `(${i + 1}) ${s}`).join(" ")}`;
}

export const DOMAIN_STATUS_LABEL: Record<DomainStatus, string> = {
  pending_dns: "Waiting for your DNS change",
  active: "Connected",
  detached: "Not connected",
  disabled: "Stopped: TXT record missing",
};

/** The record to add, as DNS dashboards ask for it. An apex (example.com) can't have a CNAME, so it gets A. */
export function frontDoorRecord(host: string, target: { cname: string | null; a: string | null }, apex: boolean): { type: "CNAME" | "A"; value: string } | null {
  if (!apex && target.cname) return { type: "CNAME", value: target.cname };
  if (target.a) return { type: "A", value: target.a };
  return null;
}
