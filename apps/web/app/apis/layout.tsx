import type { ReactNode } from "react";
import { SessionSeed } from "@/components/session-seed";
import { shortAddress } from "@/lib/copy";
import { readPageSession } from "@/lib/page-auth";

/** Seller pages know the session on the server: pass it to the header so it is right from hydration. */
export default async function ApisLayout({ children }: { children: ReactNode }) {
  const session = await readPageSession();
  return (
    <>
      {session && <SessionSeed address={shortAddress(session.addr)} />}
      {children}
    </>
  );
}
