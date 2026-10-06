import Link from "next/link";
import { DoorDoodle } from "@/components/brand/doodles";
import { WalletLogin } from "@/components/wallet-login";
import { safeNextPath } from "@/lib/flow";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <section className="mx-auto max-w-xl space-y-6 py-6 sm:py-12">
      <div className="rounded-[2px] border-2 border-ink bg-frost p-6 shadow-hard sm:p-10">
        <DoorDoodle className="h-14" />
        <h1 className="mt-5 text-h font-medium uppercase">Sign in with your Cardano wallet</h1>
        <p className="mt-4 text-body-lg">
          Your wallet address is your account, and the address buyers pay. Signing in asks your wallet to sign a short
          message. It costs nothing and moves no funds.
        </p>
        <div className="mt-8">
          <WalletLogin next={safeNextPath(next)} />
        </div>
        <p className="mt-8 border-t border-ink pt-4 text-caption text-graphite">
          Hirakumi runs on the Cardano preprod test network. Switch your wallet to preprod before you sign in.
        </p>
      </div>
      <Link
        href="/demo"
        className="group flex items-center justify-between gap-4 rounded-[2px] border-2 border-ink bg-ice px-5 py-4 text-body-lg transition-colors duration-150 hover:bg-frost"
      >
        <span>
          <span className="block font-semibold">Explore the demo seller (read-only)</span>
          <span className="block text-body text-graphite">A live API on preprod, its numbers and its public status page. No wallet needed.</span>
        </span>
        <span aria-hidden className="shrink-0 transition-transform duration-150 ease-[var(--ease-press)] group-hover:translate-x-1">→</span>
      </Link>
    </section>
  );
}
