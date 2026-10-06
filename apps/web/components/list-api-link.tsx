"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth-client";

/** "List your API": a new listing for a signed-in seller, the login page for everyone else. */
export function ListApiLink({ className, children = "List your API" }: { className?: string; children?: ReactNode }) {
  const auth = useAuth();
  return (
    <Link href={auth.status === "in" ? "/apis/new" : "/login"} className={className}>
      {children}
    </Link>
  );
}
