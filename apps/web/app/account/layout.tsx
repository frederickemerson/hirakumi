import type { ReactNode } from "react";
import { SessionSeed } from "@/components/session-seed";
import { shortAddress } from "@/lib/copy";
import { readPageSession } from "@/lib/page-auth";

/** Like the /apis layout: the header knows the session from hydration, so it never flashes "Log in". */
export default async function AccountLayout({ children }: { children: ReactNode }) {
  const session = await readPageSession();
  return (
    <>
      {session && <SessionSeed address={shortAddress(session.addr)} />}
      {children}
    </>
  );
}
