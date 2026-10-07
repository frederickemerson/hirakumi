import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountApis } from "@/components/account-apis";
import { CopyButton } from "@/components/copy-button";
import { SokosumiAccountLink } from "@/components/sokosumi-link";
import { formatTime } from "@/lib/copy";
import { getSql } from "@/lib/db";
import { requireSellerPage } from "@/lib/page-auth";
import { getAccount } from "@/lib/repo/account";

export const metadata: Metadata = { title: "Account settings" };

export default async function AccountPage() {
  const session = await requireSellerPage("/account");
  const account = await getAccount(getSql(), session.sellerId);
  if (!account) redirect("/login?next=%2Faccount");
  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-h font-medium uppercase">Account settings</h1>
        <p className="text-body text-graphite">
          Your wallet, your APIs and what they earned.{" "}
          <Link href="/apis" className="underline underline-offset-4 hover:text-ink">Go to your APIs</Link>
        </p>
      </div>

      <AccountApis initial={account.apis}>
        <section aria-labelledby="account-details" className="space-y-3">
          <h2 id="account-details" className="text-sub font-medium uppercase">Account</h2>
          <dl className="grid gap-x-6 gap-y-3 rounded-[2px] border-2 border-ink bg-frost p-4 text-body sm:grid-cols-[180px_1fr]">
            <dt className="text-graphite">Wallet address</dt>
            <dd className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
              <code className="min-w-0 break-all">{account.address}</code>
              <CopyButton value={account.address} label="Copy address" />
            </dd>
            <dt className="text-graphite">Created</dt>
            <dd>{formatTime(account.createdAt)}</dd>
            <dt className="text-graphite">Sokosumi</dt>
            <dd><SokosumiAccountLink linked={account.sokosumiUserId !== null} /></dd>
          </dl>
          <p className="text-caption text-graphite">Buyers pay this address. It is also how you log in.</p>
        </section>
      </AccountApis>

      <form action="/api/auth/logout" method="post" className="border-t-2 border-ink pt-6">
        <button type="submit" className="text-body underline underline-offset-4 hover:text-graphite">Log out</button>
      </form>
    </section>
  );
}
