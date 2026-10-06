import { WalletLogin } from "@/components/wallet-login";
import { safeNextPath } from "@/lib/flow";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <section className="max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold">Sign in with your Cardano wallet</h1>
      <p className="text-muted-foreground">
        Your wallet address is your account. Buyers pay this address directly. Signing in asks your wallet to sign a
        short message; it costs nothing and moves no funds.
      </p>
      <WalletLogin next={safeNextPath(next)} />
    </section>
  );
}
