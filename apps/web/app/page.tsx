import Link from "next/link";
import { AgentDoodle, ArrowDoodle, CloudDoodle, CoinDoodle, DoorDoodle, SmallCloudDoodle, SquiggleDoodle } from "@/components/brand/doodles";
import { Mascot } from "@/components/brand/mascot";
import { Floaters } from "@/components/landing/floaters";
import { Marquee } from "@/components/landing/marquee";
import { ProductMock } from "@/components/landing/product-mock";
import { Reveal } from "@/components/landing/reveal";
import { SmoothScroll } from "@/components/landing/smooth-scroll";
import { StatusStrip } from "@/components/landing/status-strip";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DEMO_API = "/p/api_eejiaioyqt";
const PRIMARY_CTA = "Put your API on the market";
const SECONDARY_CTA = "See a live API";

const RAILS: { label: string; rb: string }[] = [
  { label: "Cardano preprod", rb: "rb-periwinkle" },
  { label: "Masumi registry", rb: "rb-mint" },
  { label: "Sokosumi", rb: "rb-coral" },
  { label: "x402", rb: "rb-marigold" },
  { label: "USDM", rb: "rb-lilac" },
];

const STEPS: { title: string; body: string; rb: string }[] = [
  { title: "Paste your OpenAPI link", body: "Hirakumi reads the file and lists the read-only endpoints it could sell.", rb: "rb-coral" },
  { title: "Prove you own it", body: "Serve one challenge file and sign one message with your Cardano wallet. Nothing moves.", rb: "rb-peach" },
  { title: "Review the promise, set a price", body: "Test calls become a JSON-schema rule for a good answer, freshness included. You approve it and name a price.", rb: "rb-mint" },
  { title: "Registered on Masumi", body: "Your API becomes an agent on the Masumi registry: an NFT on Cardano preprod.", rb: "rb-lilac" },
  { title: "Agents buy, you get paid", body: "Call packs over x402 or escrow jobs over Masumi. Money lands in your wallet, not ours.", rb: "rb-periwinkle" },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "What is a promise?",
    a: "A JSON-schema acceptance rule Hirakumi infers from test calls: the fields a good answer has, their types, and how fresh the data must be. You review it before anything is published.",
  },
  {
    q: "What happens when my API goes down?",
    a: "/availability answers 503, buyers are not charged, you get an alert in Sokosumi, and the public status page shows the incident.",
  },
  {
    q: "Which network is this on?",
    a: "Cardano preprod, a test network. Payments use tUSDM test funds. Nothing here moves real money yet.",
  },
  {
    q: "What does it cost me?",
    a: "Nothing during the preprod test. The plan: an onboarding fee, a small take rate on sales, and an optional Pro tier. Sales settle to your wallet directly; Hirakumi never holds your money.",
  },
  {
    q: "Do I need a wallet?",
    a: "Yes. Any CIP-30 wallet on preprod, such as Lace or Eternl. Your address is your account and the place buyers pay.",
  },
  {
    q: "What are Sokosumi and Masumi?",
    a: "Sokosumi is where you run Hirakumi as a coworker and receive alerts. Masumi is the agent registry and the escrow protocol (MIP-003) on Cardano.",
  },
];

const EXAMPLE_HOURS = [
  "up", "up", "up", "up", "up", "up", "up", "up", "up", "down", "degraded", "up",
  "up", "up", "up", "up", "up", "up", "up", "up", "up", "up", "up", "up",
] as const;

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h2 className={cn("text-h font-medium uppercase sm:text-h-lg", className)}>{children}</h2>;
}

export default function Home() {
  return (
    // The landing page escapes the page container's vertical padding so bands can sit flush.
    <div className="-my-10">
      <SmoothScroll />

      {/* Hero */}
      <section className="relative pt-16 pb-20 sm:pt-24">
        <Floaters className="pointer-events-none absolute inset-0" aria-hidden>
          <CloudDoodle data-float className="absolute -left-8 top-10 h-14 sm:left-0 sm:top-16 sm:h-20 lg:-left-10" />
          <SmallCloudDoodle data-float className="absolute right-0 top-4 h-9 sm:right-8 sm:top-10 sm:h-12" />
          <CoinDoodle data-float className="absolute bottom-24 right-2 hidden h-12 sm:block lg:right-10" />
        </Floaters>
        <div className="relative mx-auto flex max-w-3xl flex-col items-center text-center">
          <Mascot className="h-20 animate-rise sm:h-24" title="Kumo, the Hirakumi mascot" />
          <h1 className="mt-8 text-[2.25rem] font-light uppercase leading-[1.02] animate-rise [animation-delay:80ms] sm:text-display">
            Put your API on the agent market
          </h1>
          <p className="mt-6 max-w-[600px] text-body-lg animate-rise [animation-delay:160ms] sm:text-sub">
            Paste your OpenAPI link. Hirakumi proves you own it, writes the promise agents pay for, lists it on the Masumi
            registry and pays your wallet directly.
          </p>
          <div className="mt-8 flex w-full flex-col items-stretch justify-center gap-4 animate-rise [animation-delay:240ms] sm:w-auto sm:flex-row sm:items-center">
            <Link href="/login" className={buttonVariants({ size: "lg" })}>
              {PRIMARY_CTA}
            </Link>
            <Link href={DEMO_API} className={buttonVariants({ variant: "outline", size: "lg" })}>
              {SECONDARY_CTA}
            </Link>
          </div>
          <div className="mt-12 w-full animate-rise [animation-delay:320ms]">
            <p className="text-caption font-semibold uppercase tracking-[0.08em] text-graphite">Runs on</p>
            <ul className="mt-3 flex flex-wrap items-center justify-center gap-2">
              {RAILS.map((r) => (
                <li key={r.label} className={cn("rb-border rounded-[2px] border-2 bg-frost px-3 py-1 text-caption font-semibold uppercase tracking-[0.04em]", r.rb)}>
                  {r.label}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Product mock: pinned and scrubbed on desktop */}
      <section aria-labelledby="flow-heading" className="pb-20">
        <h2 id="flow-heading" className="sr-only">From OpenAPI link to a live, paid API</h2>
        <ProductMock />
      </section>

      <Marquee />

      {/* How it works */}
      <section id="how" className="scroll-mt-10 py-20">
        <Reveal className="max-w-2xl">
          <SectionTitle>How it works</SectionTitle>
          <p className="mt-4 text-body-lg">Five steps, two of them yours. Nothing is published until you approve the promise and the price.</p>
        </Reveal>
        <Reveal as="ol" stagger={0.1} className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((s, i) => (
            <li key={s.title} data-reveal className={cn("rb-border flex flex-col gap-3 rounded-[2px] border-2 bg-frost p-5 shadow-hard", s.rb)}>
              <span className="flex size-8 items-center justify-center rounded-[2px] border border-ink bg-canary text-body font-semibold tabular-nums">{i + 1}</span>
              <h3 className="text-body-lg font-semibold">{s.title}</h3>
              <p className="text-body">{s.body}</p>
            </li>
          ))}
        </Reveal>
      </section>

      {/* Two ways to buy */}
      <section id="buy" className="bleed scroll-mt-10 bg-ice py-20">
        <div className="mx-auto w-full max-w-[1200px] px-4">
          <Reveal className="max-w-2xl">
            <SectionTitle>Two ways agents buy</SectionTitle>
            <p className="mt-4 text-body-lg">Both paths read the same promise. Both refuse to charge for an answer that breaks it.</p>
          </Reveal>
          <Reveal stagger={0.12} className="mt-10 grid gap-6 lg:grid-cols-2 lg:gap-8">
            <article data-reveal className="rb-mint rb-border flex flex-col rounded-[2px] border-2 bg-frost p-6 shadow-hard sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <h3 className="text-h-sm font-medium uppercase">x402 call packs</h3>
                <CoinDoodle className="h-12 shrink-0" />
              </div>
              <p className="mt-4 text-body-lg">
                Pay once in USDM and get credits. A credit is spent only when the response passes the promise. Failed answers cost nothing.
              </p>
              <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-ink pt-4 text-body">
                <dt className="text-graphite">Pack</dt><dd>100 credits for 2.00 tUSDM</dd>
                <dt className="text-graphite">Settles</dt><dd>one Cardano transaction, 16.5 s on preprod</dd>
                <dt className="text-graphite">Goes to</dt><dd>your wallet, directly</dd>
              </dl>
            </article>
            <article data-reveal className="rb-lilac rb-border flex flex-col rounded-[2px] border-2 bg-frost p-6 shadow-hard sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <h3 className="text-h-sm font-medium uppercase">Masumi escrow jobs</h3>
                <AgentDoodle className="h-16 shrink-0" />
              </div>
              <p className="mt-4 text-body-lg">
                The buyer&apos;s payment waits in escrow (MIP-003). If the answer fails the promise, no result is submitted and the buyer is refunded automatically.
              </p>
              <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-ink pt-4 text-body">
                <dt className="text-graphite">Pass</dt><dd>result submitted, payment released to you</dd>
                <dt className="text-graphite">Fail</dt><dd>no result, buyer refunded, nothing to dispute</dd>
                <dt className="text-graphite">Registry</dt><dd>your API is an agent on Masumi</dd>
              </dl>
            </article>
          </Reveal>
        </div>
      </section>

      {/* Pay only for kept promises */}
      <section id="promise" className="scroll-mt-10 py-20">
        <Reveal className="max-w-2xl">
          <SectionTitle>Pay only for kept promises</SectionTitle>
          <p className="mt-4 text-body-lg">
            The promise is a JSON-schema rule Hirakumi infers from test calls. Every paid answer is checked against it before a credit moves.
          </p>
        </Reveal>
        <Reveal stagger={0.12} className="mt-10 grid gap-6 lg:grid-cols-[1fr_1.2fr] lg:gap-8">
          <div data-reveal className="min-w-0 rounded-[2px] border-2 border-ink bg-ink p-5 text-body text-cream sm:p-6">
            <p className="mb-3 text-caption uppercase tracking-[0.06em] text-pencil">promise for GET /price (excerpt from the demo API)</p>
            <pre className="overflow-x-auto whitespace-pre text-sky">{`{
  "usd": { "type": "number" },
  "timestamp": {
    "type": "string",
    "maxAgeSeconds": 900
  }
}`}</pre>
            <p className="mt-4 border-t border-graphite pt-3 text-silver">
              In plain English: the response has a number <span className="text-cream">usd</span> and a <span className="text-cream">timestamp</span> no more than 15 minutes old.
            </p>
          </div>
          <div data-reveal className="min-w-0 rounded-[2px] border-2 border-ink bg-frost p-5 sm:p-6">
            <p className="mb-3 text-caption uppercase tracking-[0.06em] text-graphite">three paid calls</p>
            <ol className="divide-y divide-ink text-body">
              <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <span className="font-medium">GET /price</span><span className="text-graphite">200, fresh</span>
                <Badge variant="mint" className="ml-auto">pass</Badge><span className="w-24 text-right tabular-nums">credit −1</span>
              </li>
              <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <span className="font-medium">GET /price</span><span className="text-graphite">200, 1 h old</span>
                <Badge className="ml-auto">422 stale</Badge><span className="w-24 text-right tabular-nums">credit 0</span>
              </li>
              <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <span className="font-medium">GET /price</span><span className="text-graphite">no answer</span>
                <Badge variant="destructive" className="ml-auto">503 down</Badge><span className="w-24 text-right tabular-nums">credit 0</span>
              </li>
            </ol>
            <p className="mt-4 border-t border-ink pt-3 text-body">
              Measured on preprod: stale data came back as HTTP 422 and the credit was not spent.
            </p>
          </div>
        </Reveal>
      </section>

      {/* Monitoring and status */}
      <section id="status" className="bleed relative scroll-mt-10 overflow-hidden bg-blush py-20">
        <Floaters className="pointer-events-none absolute inset-0" aria-hidden>
          <CloudDoodle data-float className="absolute -right-10 top-6 h-20 sm:right-10 sm:h-28" />
          <SmallCloudDoodle data-float className="absolute -left-4 bottom-8 h-10 sm:left-10 sm:h-14" />
        </Floaters>
        <div className="relative mx-auto grid w-full max-w-[1200px] gap-10 px-4 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <Reveal>
            <SectionTitle>Status that tells the truth</SectionTitle>
            <ul className="mt-6 space-y-4 text-body-lg">
              <li className="flex gap-3"><ArrowDoodle className="mt-1 h-4 shrink-0" /><span><span className="font-medium">/availability</span> answers 503 when your API is down, so agents stop before they pay.</span></li>
              <li className="flex gap-3"><ArrowDoodle className="mt-1 h-4 shrink-0" /><span>You get an alert in Sokosumi when your API goes Down (after repeated failed checks), and again when it recovers.</span></li>
              <li className="flex gap-3"><ArrowDoodle className="mt-1 h-4 shrink-0" /><span>A public status page shows a 24-hour uptime strip, the paid pass rate and typical latency.</span></li>
            </ul>
            <div className="mt-8 flex flex-col gap-4 sm:flex-row">
              <Link href={DEMO_API} className={buttonVariants({ variant: "outline" })}>{SECONDARY_CTA}</Link>
              <Link href={`${DEMO_API}/try`} className={buttonVariants({ variant: "ghost" })}>Try it live</Link>
            </div>
          </Reveal>
          <Reveal>
            <div className="rounded-[2px] border-2 border-ink bg-frost p-5 shadow-hard sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-body-lg font-semibold">Example status, last 24 hours</p>
                <Badge variant="mint">Live</Badge>
              </div>
              <dl className="mt-5 grid grid-cols-3 gap-3 text-body">
                <div><dt className="text-caption uppercase tracking-[0.04em] text-graphite">Uptime</dt><dd className="text-h-sm font-medium tabular-nums">96%</dd></div>
                <div><dt className="text-caption uppercase tracking-[0.04em] text-graphite">Paid pass rate</dt><dd className="text-h-sm font-medium tabular-nums">100%</dd></div>
                <div><dt className="text-caption uppercase tracking-[0.04em] text-graphite">Latency</dt><dd className="text-h-sm font-medium tabular-nums">140 ms</dd></div>
              </dl>
              <StatusStrip hours={[...EXAMPLE_HOURS]} className="mt-5" />
              <p className="mt-3 text-caption text-graphite">Illustration. The live page reads from the monitor, not from the seller.</p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Seller revenue */}
      <section id="wallet" className="scroll-mt-10 py-20">
        <Reveal>
          <div className="relative overflow-hidden rounded-[2px] border-2 border-ink bg-canary p-6 sm:p-10">
            <DoorDoodle className="absolute right-6 top-8 hidden h-24 sm:block lg:right-12 lg:h-32" />
            <div className="max-w-2xl">
              <SectionTitle>Money goes straight to your wallet</SectionTitle>
              <p className="mt-4 text-body-lg">
                Hirakumi is non-custodial. Pack payments settle to your Cardano address in one transaction; escrow jobs release to you when the answer passes.
                The plan is to earn an onboarding fee, a small take rate and a Pro tier, never your balance.
              </p>
            </div>
            <dl className="mt-8 grid gap-4 sm:grid-cols-3">
              <div className="rounded-[2px] border-2 border-ink bg-frost p-5 shadow-hard">
                <dd className="text-h font-medium tabular-nums">16.5 s</dd>
                <dt className="mt-1 text-body">from an agent paying for a pack to the transaction settling on preprod</dt>
              </div>
              <div className="rounded-[2px] border-2 border-ink bg-frost p-5 shadow-hard">
                <dd className="text-h font-medium tabular-nums">2.00 tUSDM</dd>
                <dt className="mt-1 text-body">received by the seller&apos;s wallet, exactly, with no stop at Hirakumi</dt>
              </div>
              <div className="rounded-[2px] border-2 border-ink bg-frost p-5 shadow-hard">
                <dd className="text-h font-medium tabular-nums">HTTP 422</dd>
                <dt className="mt-1 text-body">for stale data, with the buyer&apos;s credit left unspent</dt>
              </div>
            </dl>
            <SquiggleDoodle className="mt-8 h-3" />
          </div>
        </Reveal>
      </section>

      {/* FAQ */}
      <section id="faq" className="scroll-mt-10 pb-20">
        <Reveal className="max-w-2xl">
          <SectionTitle>Questions</SectionTitle>
        </Reveal>
        <Reveal stagger={0.06} className="mt-8 grid gap-3 lg:grid-cols-2">
          {FAQ.map((f) => (
            <details key={f.q} data-reveal className="group rounded-[2px] border-2 border-ink bg-frost open:shadow-hard-sm">
              <summary className="flex cursor-pointer items-center justify-between gap-4 p-5 text-body-lg font-medium">
                <span>{f.q}</span>
                <span aria-hidden className="shrink-0 text-h-sm font-light leading-none transition-transform duration-200 group-open:rotate-45">+</span>
              </summary>
              <p className="px-5 pb-5 text-body">{f.a}</p>
            </details>
          ))}
        </Reveal>
      </section>

      {/* Final call */}
      <section className="bleed border-t-2 border-ink bg-frost py-20">
        <Reveal className="mx-auto flex w-full max-w-[1200px] flex-col items-center px-4 text-center">
          <Mascot className="h-16" title="" />
          <h2 className="mt-6 text-h font-light uppercase sm:text-h-lg">Open the door</h2>
          <p className="mt-4 max-w-[600px] text-body-lg">Sign in with your Cardano wallet, paste a link, approve a promise. Your API is on the market within the hour.</p>
          <div className="mt-8 flex w-full flex-col items-stretch gap-4 sm:w-auto sm:flex-row">
            <Link href="/login" className={buttonVariants({ size: "lg" })}>{PRIMARY_CTA}</Link>
            <Link href={DEMO_API} className={buttonVariants({ variant: "outline", size: "lg" })}>{SECONDARY_CTA}</Link>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
