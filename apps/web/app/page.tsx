import Link from "next/link";
import { CloudDoodle, SmallCloudDoodle } from "@/components/brand/doodles";
import { Mascot } from "@/components/brand/mascot";
import { Floaters } from "@/components/landing/floaters";
import { CountUp } from "@/components/landing/count-up";
import { Marquee } from "@/components/landing/marquee";
import { Parallax } from "@/components/landing/parallax";
import { Receipt } from "@/components/landing/receipt";
import { Reveal } from "@/components/landing/reveal";
import { ScrubText, type Paragraph } from "@/components/landing/scrub-text";
import { SmoothScroll } from "@/components/landing/smooth-scroll";
import { StepLine } from "@/components/landing/step-line";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DEMO_API = "/p/api_eejiaioyqt";
const PRIMARY_CTA = "List your API";
const SECONDARY_CTA = "Try a live API";

/* The argument, read at scroll speed: why now, what is broken, and the one idea that fixes it. */
const WHY: Paragraph[] = [
  {
    text: "AI agents now have wallets. They can find an API on the Masumi registry or the Sokosumi marketplace and pay for it on Cardano. Most APIs are not ready to be paid that way.",
  },
  {
    text: "APIs are still sold with keys, monthly plans and invoices. An agent has none of those; it has a wallet and a task. Paying per call on-chain costs about 1.4 ADA in overhead and 20 seconds per payment. And a stale answer costs the buyer the same as a fresh one.",
  },
  {
    text: "So sell calls in packs, and make each credit conditional on the answer. Your API publishes a promise: a rule a machine can check. An answer that breaks it costs the buyer nothing.",
    strong: true,
  },
];

const STEPS: { title: string; body: string; rb: string }[] = [
  {
    title: "Paste your OpenAPI link",
    body: "Hirakumi reads it and lists the read-only endpoints it can sell. You prove you own the API with one file on your domain and one wallet signature.",
    rb: "rb-coral",
  },
  {
    title: "Approve the promise and a price",
    body: "Test calls become a promise: the fields a good answer has, their types and how fresh the data must be. You check it and set a pack price.",
    rb: "rb-mint",
  },
  {
    title: "You're live",
    body: "Agents on Masumi and Sokosumi find your API and buy call packs in USDM on Cardano. Each pack payment settles to your wallet.",
    rb: "rb-periwinkle",
  },
];

const LIVE_TODAY = [
  "Pack payments settle straight to the seller's wallet",
  "A credit is used only when the answer keeps the promise",
  "A receipt for every paid call, open to the buyer",
  "Single jobs through Masumi, refunded on-chain when the answer fails",
  "Monitoring with a public status page",
];

/* Speed first. Each number counts in as its row scrolls into view; `from` is where the count starts. */
const PROOF: { value: number; decimals: number; from: number; unit: string; label: string }[] = [
  { value: 9.4, decimals: 1, from: 0, unit: "s", label: "for an agent's payment to settle on Cardano" },
  { value: 0.3, decimals: 1, from: 0, unit: "s", label: "per paid call, end to end" },
  { value: 0, decimals: 0, from: 1, unit: "credits", label: "charged for a stale or broken answer" },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Who decides pass or fail?",
    a: "Our gateway, against the rule your API published before the sale. Every paid call is logged with its verdict, and the buyer can read the log at /receipts.",
  },
  {
    q: "What happens when my API goes down?",
    a: "Nobody is charged. The gateway answers 503, credits stay where they are, and the public status page shows the outage.",
  },
  {
    q: "Is this on mainnet?",
    a: "No. Everything runs on Cardano preprod, a test network, with test USDM. Nothing here moves real money.",
  },
  {
    q: "What does it cost?",
    a: "Nothing on preprod. The plan is an onboarding fee and a small take rate on sales. Pack payments settle to your wallet; Hirakumi never holds your money.",
  },
  {
    q: "What does a promise look like?",
    a: "A JSON-schema rule for a good answer. For the demo API: GET /price returns symbol, usd, change24h and a timestamp no older than 15 minutes.",
  },
  {
    q: "Do I need a wallet?",
    a: "Yes. Any CIP-30 wallet on preprod, such as Lace or Eternl. Your address is your account and the place buyers pay.",
  },
];

function H2({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h2 className={cn("text-h font-normal uppercase sm:text-h-lg", className)}>{children}</h2>;
}

export default function Home() {
  return (
    // The landing page escapes the page container's vertical padding so bands can sit flush.
    <div className="-my-10">
      <SmoothScroll />

      {/* Hero: the promise to the reader on the left, the receipt that explains the product on the right. */}
      <section className="relative pt-12 pb-16 sm:pt-16 lg:pt-20 lg:pb-24">
        <Floaters className="pointer-events-none absolute inset-0" aria-hidden>
          <CloudDoodle data-float className="absolute -left-10 top-0 hidden h-20 sm:block lg:-left-16 lg:top-6" />
          <SmallCloudDoodle data-float className="absolute right-0 top-0 h-8 sm:-top-2 sm:h-12 lg:-right-12 lg:top-2" />
        </Floaters>
        <div className="relative grid gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center lg:gap-16">
          <div className="max-w-[40rem]">
            <h1 className="text-[2.5rem] font-light uppercase leading-[1.02] animate-rise sm:text-display">
              Make your APIs monetizable
            </h1>
            <p className="mt-6 max-w-[36rem] text-body-lg animate-rise [animation-delay:70ms] sm:text-sub">
              Paste your OpenAPI link, sign with your Cardano wallet, set a pack price. AI agents pay in USDM, and stale or empty answers cost them nothing.
            </p>
            <div className="mt-8 flex flex-col items-stretch gap-4 animate-rise [animation-delay:140ms] sm:flex-row sm:items-center">
              <Link href="/login" className={buttonVariants({ size: "lg" })}>
                {PRIMARY_CTA}
              </Link>
              <Link href={`${DEMO_API}/try`} className={buttonVariants({ variant: "outline", size: "lg" })}>
                {SECONDARY_CTA}
              </Link>
            </div>
          </div>
          <Parallax distance={36}>
            <Receipt className="animate-rise [animation-delay:240ms]" />
          </Parallax>
        </div>
      </section>

      <Marquee />

      {/* Why: the argument, read at scroll speed. */}
      <section id="why" className="scroll-mt-10 py-20 sm:py-28">
        <ScrubText paragraphs={WHY} className="max-w-[52rem] text-sub leading-[1.5] sm:text-h-sm sm:leading-[1.45]" />
      </section>

      {/* How it works: three steps, one real sequence. */}
      <section id="how" className="scroll-mt-10 border-t-2 border-ink py-20 sm:py-28">
        <Reveal className="max-w-2xl">
          <H2>How it works</H2>
          <p className="mt-4 text-body-lg">Three steps. Nothing is published until you approve the promise and the price.</p>
        </Reveal>
        {/* The line through the step numbers fills as the steps scroll by (StepLine). */}
        <div className="relative mt-12">
          <StepLine />
          <Reveal as="ol" stagger={0.1} className="relative grid gap-10 md:grid-cols-3 md:gap-8">
            {STEPS.map((s, i) => (
              <li key={s.title} data-reveal className="grid grid-cols-[2.5rem_minmax(0,1fr)] content-start gap-x-4 gap-y-3 md:flex md:flex-col md:gap-4">
                <span data-step-badge className={cn("rb-border flex size-10 items-center justify-center rounded-[2px] border-2 bg-frost text-body-lg font-semibold tabular-nums shadow-hard-sm", i === 1 ? "row-span-3" : "row-span-2", s.rb)}>
                  {i + 1}
                </span>
                <h3 className="col-start-2 self-center text-sub font-semibold md:self-auto">{s.title}</h3>
                <p className="col-start-2 text-body-lg text-graphite">{s.body}</p>
                {i === 1 && (
                  <pre className="col-start-2 mt-1 overflow-x-auto rounded-[2px] border-2 border-ink bg-ink p-4 text-caption leading-relaxed text-sky">{`"usd":       { "type": "number" }
"timestamp": { "type": "string",
               "maxAgeSeconds": 900 }`}</pre>
                )}
              </li>
            ))}
          </Reveal>
        </div>
      </section>

      {/* Trust: where the money sits today, and what is proven but not yet the default. */}
      <section id="trust" className="bleed scroll-mt-10 border-t-2 border-ink bg-ice py-20 sm:py-28">
        <div className="mx-auto w-full max-w-[1200px] px-4">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
            <Reveal>
              <H2>How the money is protected</H2>
              <p className="mt-6 text-body-lg sm:text-sub">
                Today a pack payment settles straight to the seller&apos;s wallet. Hirakumi&apos;s gateway checks every answer against the
                promise and only then uses a credit. A stale, empty or failed answer is free.
              </p>
              <p className="mt-6 text-body-lg text-graphite">
                Every paid call is logged with its verdict, and the buyer can audit the log at /receipts.
              </p>
            </Reveal>
            <Reveal as="dl" stagger={0.12} className="grid gap-6 sm:grid-cols-2 lg:grid-cols-1">
              <div data-reveal className="rounded-[2px] border-2 border-ink bg-frost p-6 shadow-hard">
                <dt className="flex items-center justify-between gap-4 text-caption font-semibold uppercase tracking-[0.06em]">
                  Live on Cardano preprod today
                  <span aria-hidden className="inline-block size-2.5 border border-ink bg-mint" />
                </dt>
                <dd>
                  <ul className="mt-4 space-y-2 text-body-lg">
                    {LIVE_TODAY.map((t) => (
                      <li key={t} className="flex gap-3">
                        <span aria-hidden className="mt-[0.7em] size-1.5 shrink-0 bg-ink" />
                        <span>{t}</span>
                      </li>
                    ))}
                  </ul>
                  <Link href={DEMO_API} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-6")}>
                    See a live status page
                  </Link>
                </dd>
              </div>
              <div data-reveal className="rounded-[2px] border-2 border-ink bg-frost p-6">
                <dt className="text-caption font-semibold uppercase tracking-[0.06em]">Proven on preprod, rolling out next</dt>
                <dd className="mt-4 space-y-3 text-body-lg">
                  <p>
                    An escrow channel: the pack money waits in a Cardano contract, the buyer signs for each answer that kept the
                    promise, and the seller is paid for those calls only. The rest goes back to the buyer.
                  </p>
                  <p className="text-graphite">
                    Settled end to end on preprod, with <span className="font-medium tabular-nums text-ink">110 contract tests</span> passing.
                  </p>
                </dd>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Proof: what was measured, nothing else. */}
      <section id="proof" className="scroll-mt-10 border-t-2 border-ink py-20 sm:py-28">
        <Reveal className="max-w-2xl">
          <H2>Fast, and fair</H2>
          <p className="mt-4 text-body-lg">Measured on Cardano preprod with test funds.</p>
        </Reveal>
        <Reveal as="dl" stagger={0.08} className="mt-12 grid gap-y-10 sm:grid-cols-3 sm:gap-x-8">
          {PROOF.map((p) => (
            <div key={p.label} data-reveal data-stat className="flex flex-col border-t-2 border-ink pt-5">
              <dt className="order-2 mt-4 max-w-[18rem] text-body-lg text-graphite">{p.label}</dt>
              <dd className="order-1 flex items-baseline gap-3 whitespace-nowrap font-light leading-none">
                <CountUp value={p.value} from={p.from} decimals={p.decimals} className="text-[3.5rem] lg:text-[5rem]" />
                <span className="text-h-sm lg:text-h">{p.unit}</span>
              </dd>
            </div>
          ))}
        </Reveal>
      </section>

      {/* FAQ: the real objections, answered plainly. */}
      <section id="faq" className="scroll-mt-10 border-t-2 border-ink py-20 sm:py-28">
        <Reveal className="max-w-2xl">
          <H2>Questions</H2>
        </Reveal>
        <Reveal as="dl" stagger={0.06} className="mt-12 grid gap-x-12 gap-y-10 md:grid-cols-2">
          {FAQ.map((f) => (
            <div key={f.q} data-reveal className="border-t border-ink pt-5">
              <dt className="text-sub font-semibold">{f.q}</dt>
              <dd className="mt-3 max-w-[34rem] text-body-lg text-graphite">{f.a}</dd>
            </div>
          ))}
        </Reveal>
      </section>

      {/* Final call */}
      <section className="bleed relative overflow-hidden border-t-2 border-ink bg-frost py-20 sm:py-28">
        <Floaters className="pointer-events-none absolute inset-0" aria-hidden>
          <SmallCloudDoodle data-float className="absolute left-[8%] top-10 h-10 sm:h-12" />
          <CloudDoodle data-float className="absolute right-[6%] bottom-10 h-14 sm:h-20" />
        </Floaters>
        <Reveal className="relative mx-auto flex w-full max-w-[1200px] flex-col items-center px-4 text-center">
          <Mascot className="h-16" title="" />
          <h2 className="mt-6 text-h font-light uppercase sm:text-h-lg">Start with one link</h2>
          <p className="mt-4 max-w-[34rem] text-body-lg">
            Paste your OpenAPI link, sign with your Cardano wallet, approve the promise and the price. That is the whole onboarding.
          </p>
          <div className="mt-8 flex w-full flex-col items-stretch gap-4 sm:w-auto sm:flex-row">
            <Link href="/login" className={buttonVariants({ size: "lg" })}>{PRIMARY_CTA}</Link>
            <Link href={`${DEMO_API}/try`} className={buttonVariants({ variant: "outline", size: "lg" })}>{SECONDARY_CTA}</Link>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
