import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DoorDoodle } from "@/components/brand/doodles";
import { WalletLogin } from "@/components/wallet-login";
import { safeNextPath } from "@/lib/flow";
import { readPageSession } from "@/lib/page-auth";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Already logged in: go where they were headed instead of asking for a signature again.
  if (await readPageSession()) redirect(safeNextPath(next));
  return (
    <section className="mx-auto max-w-xl space-y-6 py-6 sm:py-12">
      <div className="rounded-[2px] border-2 border-ink bg-frost p-6 shadow-hard sm:p-10">
        <DoorDoodle className="h-14" />
        <h1 className="mt-5 text-h font-medium uppercase">Log in with your Cardano wallet</h1>
        <p className="mt-4 text-body-lg">
          Your wallet address is your account, and the address buyers pay. Logging in asks your wallet to sign a short
          message. It costs nothing and moves no funds.
        </p>
        <div className="mt-8">
          <WalletLogin next={safeNextPath(next)} />
        </div>
        <p className="mt-8 border-t border-ink pt-4 text-caption text-graphite">
          Hirakumi runs on the Cardano preprod test network. Switch your wallet to preprod before you log in.
        </p>
      </div>
    </section>
  );
}
