import Link from "next/link";
import { Check, X } from "lucide-react";
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
import { ListApiLink } from "@/components/list-api-link";
import { tryHref } from "@/components/try-live-link";
import { DEMO_API_ID } from "@/lib/demo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DEMO_API = `/p/${DEMO_API_ID}`;
const PRIMARY_CTA = "List your API";
const SECONDARY_CTA = "Buy a real pack in your browser";

const CARDANOSCAN = "https://preprod.cardanoscan.io/transaction/";
/** Mika's FX Rates on preprod: the settle that paid the seller for signed answers, and the Masumi registry mint. */
const SETTLE_TX = "d64f790605dbda025dbf92272c0546ea0fe02ab6f10984516df064da0fa4fdaa";
const REGISTRY_TX = "8f04206b27e66266d61f22423c01447cad88582fb9c7fd7b96b7ac1f728e602a";

/* The problem for enterprises and institutions, read at scroll speed. The figures between the two blocks are MuleSoft's. */
const PROBLEM: Paragraph[] = [
  {
    text: "Enterprises and institutions sit on lots of good APIs. Making one payable by AI agents means new code inside big, siloed codebases: billing, wallets, refunds and an agent wrapper, each change waiting on security review and the next release.",
  },
];
const TRUST_GAP: Paragraph[] = [
  {
    text: "So most of these APIs never earn a cent from agents. And even on Masumi, Cardano's marketplace for AI agents, buyers have no trust layer: they pay even for empty or stale answers, because the seller grades its own work.",
  },
  { text: "An AI can write you an agent, but it can't be its own trust layer.", strong: true },
];

const INTEGRATION: { value: number; unit: string; label: string }[] = [
  { value: 897, unit: "", label: "applications in the average enterprise" },
  { value: 29, unit: "%", label: "of them connected" },
  { value: 39, unit: "%", label: "of IT time spent on custom integrations" },
];

const YOURSELF = [
  "Build an agent around your API",
  "Run your own payment node",
  "Register it in the Masumi directory",
  "Handle payments and refunds",
  "Keep its status honest, all day",
];

const STEPS: { title: string; body: string; tag: string; rb: string }[] = [
  {
    title: "Bring any API",
    body: "No OpenAPI file needed: a base URL and a few example requests are enough. We test it and describe it for agents.",
    tag: "Off chain",
    rb: "rb-coral",
  },
  {
    title: "Prove it's yours",
    body: "One DNS TXT record, then one signature binds your payout address. Sign in with Google or email through UTXOS, or use a Cardano wallet.",
    tag: "One signature",
    rb: "rb-peach",
  },
  {
    title: "Seal the key",
    body: "If your API needs a key, it is sealed so only our gateway can use it, and never shown again.",
    tag: "Off chain",
    rb: "rb-mint",
  },
  {
    title: "Set the promise",
    body: "Inferred from real test calls: the fields a good answer has and how fresh it must be. Its hash is public before any sale.",
    tag: "Off chain",
    rb: "rb-lilac",
  },
  {
    title: "Publish",
    body: "Registered as an agent on Masumi with a registry token, and sold in packs of 100 answers.",
    tag: "On Cardano",
    rb: "rb-periwinkle",
  },
];

const BUYER_STEPS: { title: string; body: string }[] = [
  { title: "See the offer", body: "The agent calls the API and gets a 402 with the price and the promise." },
  { title: "Pay once", body: "One x402 payment in USDM on Cardano buys 100 calls, direct or into the safe." },
  { title: "Ask", body: "Each question goes through Hirakumi, which calls the API with the sealed key and checks the answer." },
];

const ESCROW_STEPS: { title: string; body: string }[] = [
  { title: "Money goes into a safe", body: "The payment waits in an Aiken smart contract, not with Hirakumi." },
  { title: "A receipt per good answer", body: "The agent checks each answer itself and signs only for good ones." },
  { title: "Close, then a final check", body: "The pack closes on the latest receipt; anyone with a newer one can raise it." },
  { title: "Everyone paid fairly", body: "The seller for the good answers, Hirakumi 3%, the agent the rest back." },
];

/* Slide 3: each layer adds what the last one lacks. true, false or a short word. */
const LAYERS = ["x402", "Masumi", "Hirakumi"] as const;
const LAYER_NOTES = ["payments", "agent directory", "done for you"];
const COMPARE: { row: string; cells: [boolean | string, boolean | string, boolean | string] }[] = [
  { row: "Agents pay over the web", cells: [true, true, true] },
  { row: "Found by AI agents", cells: [false, true, true] },
  { row: "Money held, with refunds", cells: [false, true, true] },
  { row: "Independent trust layer", cells: [false, false, true] },
  { row: "Cheap for single answers", cells: [false, false, true] },
  { row: "Pay only for good answers", cells: [false, false, true] },
  { row: "Honest live status and alerts", cells: [false, "basic", true] },
  { row: "Setup", cells: ["build it", "build an agent", "paste a link"] },
];

/* Speed first. Each number counts in as its row scrolls into view; `from` is where the count starts. */
const PROOF: { value: number; decimals: number; from: number; unit: string; label: string }[] = [
  { value: 9.4, decimals: 1, from: 0, unit: "s", label: "for an agent's payment to settle on Cardano" },
  { value: 0.3, decimals: 1, from: 0, unit: "s", label: "per paid call, end to end" },
  // Starts on its final value: counting down from 1 would show "1 credits" on the way.
  { value: 0, decimals: 0, from: 0, unit: "credits", label: "charged for a stale or broken answer" },
];

const USE_CASES: { who: string; what: string; rb: string }[] = [
  { who: "Banks and exchanges", what: "Prices and exchange rates for trading agents.", rb: "rb-coral" },
  { who: "Logistics and travel", what: "Weather for logistics and travel agents.", rb: "rb-mint" },
  { who: "Data providers", what: "Search and company data for research agents.", rb: "rb-lilac" },
  { who: "Any developer or hobbyist", what: "A niche dataset you already host, ready to earn from agents within minutes.", rb: "rb-marigold" },
];

/* The same questions and answers are in lib/ask/facts.ts, so Ask Hirakumi answers them word for word offline. */
const FAQ: { q: string; a: string }[] = [
  {
    q: "Do I have to change my API?",
    a: "No. One DNS TXT record proves the API is yours, and the API itself stays as it is. If it needs a key, the key is sealed so only our gateway can use it.",
  },
  {
    q: "Do I need a wallet?",
    a: "No. Sign in with Google or email: UTXOS opens a non-custodial Cardano wallet that you own. A CIP-30 browser wallet such as Lace or Eternl works too. Signing costs nothing and moves no funds.",
  },
  {
    q: "Can I do it from Sokosumi?",
    a: "Yes. Assign a task to the Hirakumi coworker with your API's link, and every step happens in the task's comments. Only a signature or your API's key opens one short browser page. The coworker also tells you when your API breaks.",
  },
  {
    q: "Who decides pass or fail?",
    a: "Our gateway, against the promise your API published before the sale. Every paid call is logged with its verdict, and the buyer can read the log at /receipts. In escrow the agent also signs only for good answers.",
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
    a: "Hirakumi earns a 3% fee, paid by the escrow contract only on good answers, plus a small listing fee per API (planned). On preprod everything is paid with test tokens.",
  },
  {
    q: "What does a promise look like?",
    a: "A JSON Schema rule per endpoint, built from Hirakumi's test calls: the fields a good answer has, their types and how fresh the data must be, for example a timestamp no older than 15 minutes. You read it and approve it before publishing, and its hash is published before any sale.",
  },
];

function H2({ children, className, id }: { children: React.ReactNode; className?: string; id?: string }) {
  return <h2 id={id} className={cn("text-h font-normal uppercase sm:text-h-lg", className)}>{children}</h2>;
}

/** A filled square with a tick or a cross, as on the deck. The word is for screen readers. */
function Mark({ yes }: { yes: boolean }) {
  return (
    <span className={cn("inline-flex size-7 items-center justify-center rounded-[2px] border-2 border-ink", yes ? "bg-mint" : "bg-coral")}>
      {yes ? <Check aria-hidden className="size-4" strokeWidth={3} /> : <X aria-hidden className="size-4" strokeWidth={3} />}
      <span className="sr-only">{yes ? "Yes" : "No"}</span>
    </span>
  );
}

function TxLink({ hash, children }: { hash: string; children: React.ReactNode }) {
  return (
    <a href={`${CARDANOSCAN}${hash}`} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:no-underline">
      {children}
    </a>
  );
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
              Monetize any API in under 3 minutes
            </h1>
            <p className="mt-6 max-w-[36rem] text-body-lg animate-rise [animation-delay:70ms] sm:text-sub">
              You set a promise. AI agents pay only when you keep it.
            </p>
            <div className="mt-8 flex flex-col items-stretch gap-4 animate-rise [animation-delay:140ms] sm:flex-row sm:items-center">
              <ListApiLink className={buttonVariants({ size: "lg" })}>{PRIMARY_CTA}</ListApiLink>
              <Link href={tryHref(DEMO_API_ID)} className={buttonVariants({ variant: "outline", size: "lg" })}>
                {SECONDARY_CTA}
              </Link>
            </div>
            <p className="mt-6 text-body text-graphite animate-rise [animation-delay:200ms]">
              No change to your code. One DNS record. Sign in with Google or email.
            </p>
          </div>
          <Parallax distance={36}>
            <Receipt className="animate-rise [animation-delay:240ms]" />
          </Parallax>
        </div>
      </section>

      <Marquee />

      {/* Problem: why good enterprise APIs never reach agents, and the trust gap even where they do. */}
      <section id="why" aria-labelledby="why-title" className="scroll-mt-10 py-20 sm:py-28">
        <Reveal className="max-w-2xl">
          <H2 id="why-title">Good APIs, stuck behind a project</H2>
        </Reveal>
        <ScrubText paragraphs={PROBLEM} className="mt-10 max-w-[52rem] text-sub leading-[1.5] sm:text-h-sm sm:leading-[1.45]" />
        <figure className="mt-12">
          <Reveal as="dl" stagger={0.08} className="grid gap-y-8 sm:grid-cols-3 sm:gap-x-8">
            {INTEGRATION.map((s) => (
              <div key={s.label} data-reveal data-stat className="flex flex-col border-t-2 border-ink pt-5">
                <dt className="order-2 mt-3 max-w-[18rem] text-body-lg text-graphite">{s.label}</dt>
                <dd className="order-1 flex items-baseline gap-1 whitespace-nowrap font-light leading-none">
                  <CountUp value={s.value} className="text-[3rem] lg:text-[4rem]" />
                  {s.unit && <span className="text-h-sm lg:text-h">{s.unit}</span>}
                </dd>
              </div>
            ))}
          </Reveal>
          <figcaption className="mt-6 text-body text-graphite">Source: MuleSoft, 2025.</figcaption>
        </figure>
        <ScrubText paragraphs={TRUST_GAP} className="mt-16 max-w-[52rem] text-sub leading-[1.5] sm:text-h-sm sm:leading-[1.45]" />

        {/* Slide 2: what selling on Masumi takes, and what Hirakumi does instead. */}
        <Reveal stagger={0.1} className="mt-16 grid gap-8 lg:grid-cols-2">
          <div data-reveal className="rounded-[2px] border-2 border-ink bg-frost p-6 shadow-hard sm:p-8">
            <h3 className="text-caption font-semibold uppercase tracking-[0.06em] text-graphite">Selling on Masumi yourself</h3>
            <ul className="mt-5 space-y-3 text-body-lg">
              {YOURSELF.map((t) => (
                <li key={t} className="flex items-center gap-4">
                  <span aria-hidden className="size-6 shrink-0 rounded-[2px] border-2 border-ink" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
            <p className="mt-6 font-semibold text-graphite">A lot of setup, and still no trust layer: buyers just take your word for it.</p>
          </div>
          <div data-reveal className="flex flex-col justify-between gap-8 rounded-[2px] border-2 border-ink bg-ink p-6 text-frost shadow-hard sm:p-8">
            <div>
              <h3 className="text-caption font-semibold uppercase tracking-[0.06em] text-canary">With Hirakumi</h3>
              <p className="mt-6 text-h-sm font-light leading-snug sm:text-h">
                Paste your link. We do all of it in under 3 minutes, with no change to your code.
              </p>
            </div>
            <p className="rounded-[2px] border-2 border-canary p-4 text-body-lg">
              <span className="font-semibold text-canary">Plus the trust layer Masumi doesn&apos;t have:</span> every answer is checked
              before anyone pays for it.
            </p>
          </div>
        </Reveal>
      </section>

      {/* How it works for sellers: five steps, one real sequence (deck slide 6). */}
      <section id="how" className="scroll-mt-10 border-t-2 border-ink py-20 sm:py-28">
        <Reveal className="max-w-2xl">
          <H2>From API to Masumi agent</H2>
          <p className="mt-4 text-body-lg">Five steps. Nothing is published until you approve the promise and the price.</p>
        </Reveal>
        {/* The line through the step numbers fills as the steps scroll by (StepLine). */}
        <div className="relative mt-12">
          <StepLine />
          <Reveal as="ol" stagger={0.08} className="relative grid gap-10 lg:grid-cols-5 lg:gap-6">
            {STEPS.map((s, i) => (
              <li key={s.title} data-reveal className="grid grid-cols-[2.5rem_minmax(0,1fr)] content-start gap-x-4 gap-y-3 lg:flex lg:flex-col lg:gap-4">
                <span data-step-badge className={cn("rb-border row-span-3 flex size-10 items-center justify-center rounded-[2px] border-2 bg-frost text-body-lg font-semibold tabular-nums shadow-hard-sm", s.rb)}>
                  {i + 1}
                </span>
                <h3 className="col-start-2 self-center text-sub font-semibold lg:self-auto">{s.title}</h3>
                <p className="col-start-2 text-body-lg text-graphite">{s.body}</p>
                <span className={cn("col-start-2 w-fit rounded-[2px] border border-ink px-2 py-1 text-caption font-semibold uppercase tracking-[0.04em]", s.tag === "On Cardano" ? "bg-canary" : "bg-frost")}>
                  {s.tag}
                </span>
              </li>
            ))}
          </Reveal>
        </div>
        <Reveal className="mt-14 rounded-[2px] border-2 border-ink bg-notebook p-6 sm:p-8">
          <h3 className="text-sub font-semibold">Already on Sokosumi? Do it from a task.</h3>
          <p className="mt-3 max-w-[52rem] text-body-lg">
            Assign a task to the Hirakumi coworker with your API&apos;s link. Every step happens in the task&apos;s comments; only a
            signature or your API&apos;s key opens one short browser page. The coworker also tells you when your API breaks.
          </p>
        </Reveal>
      </section>

      {/* Buyers and the settlement layer: pay once, only good answers, and where the money waits (slides 7 and 8). */}
      <section id="trust" className="bleed scroll-mt-10 border-t-2 border-ink bg-ice py-20 sm:py-28">
        <div className="mx-auto w-full max-w-[1200px] px-4">
          <Reveal className="max-w-2xl">
            <H2>Buyers pay once, then only for good answers</H2>
          </Reveal>
          <Reveal as="ol" stagger={0.08} className="mt-12 grid gap-6 md:grid-cols-3">
            {BUYER_STEPS.map((s, i) => (
              <li key={s.title} data-reveal className={cn("rounded-[2px] border-2 border-ink p-6 shadow-hard", i === 1 ? "bg-blush" : "bg-frost")}>
                <h3 className="text-sub font-semibold">
                  <span className="tabular-nums">{i + 1}</span>&nbsp; {s.title}
                </h3>
                <p className="mt-3 text-body-lg">{s.body}</p>
              </li>
            ))}
          </Reveal>
          <Reveal stagger={0.08} className="mt-6 grid gap-6 md:grid-cols-2">
            <div data-reveal className="flex gap-4 rounded-[2px] border-2 border-ink bg-frost p-6">
              <Mark yes />
              <p className="text-body-lg"><span className="font-semibold">Promise kept.</span> The agent gets the answer. One credit is used.</p>
            </div>
            <div data-reveal className="flex gap-4 rounded-[2px] border-2 border-ink bg-frost p-6">
              <Mark yes={false} />
              <p className="text-body-lg">
                <span className="font-semibold">Promise broken.</span> A 422, and nothing is charged. If it keeps failing, the API goes Down
                and stops selling.
              </p>
            </div>
          </Reveal>

          <Reveal className="mt-20 max-w-2xl">
            <h3 className="text-h-sm font-normal uppercase sm:text-h">Hybrid settlement</h3>
          </Reveal>
          <Reveal as="dl" stagger={0.08} className="mt-8 grid gap-6 md:grid-cols-2">
            <div data-reveal className="rounded-[2px] border-2 border-ink bg-frost p-6">
              <dt className="text-caption font-semibold uppercase tracking-[0.06em]">Direct: small packs from proven sellers</dt>
              <dd className="mt-3 text-body-lg">One payment straight to the seller. Our gateway counts a credit only on a good answer.</dd>
            </div>
            <div data-reveal className="rounded-[2px] border-2 border-ink bg-blush p-6">
              <dt className="text-caption font-semibold uppercase tracking-[0.06em]">Escrow: when it matters</dt>
              <dd className="mt-3 text-body-lg">
                A large pack, a seller under 99% uptime, a listing under 7 days old, or whenever the buyer asks. Never a silent switch to
                direct.
              </dd>
            </div>
          </Reveal>
          <Reveal as="ol" stagger={0.06} className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {ESCROW_STEPS.map((s, i) => (
              <li key={s.title} data-reveal className="border-t-2 border-ink pt-4">
                <h4 className="text-body-lg font-semibold">
                  <span className="tabular-nums text-graphite">{i + 1}</span>&nbsp; {s.title}
                </h4>
                <p className="mt-2 text-body-lg text-graphite">{s.body}</p>
              </li>
            ))}
          </Reveal>
          <Reveal className="mt-10 rounded-[2px] border-2 border-ink bg-ink p-6 text-frost shadow-hard sm:p-8">
            <p className="text-sub font-semibold">Nobody can take more than the agent agreed to, not even us.</p>
          </Reveal>
        </div>
      </section>

      {/* Comparison: each layer adds what the last one lacks (slide 3). */}
      <section id="compare" aria-labelledby="compare-title" className="scroll-mt-10 border-t-2 border-ink py-20 sm:py-28">
        <Reveal className="max-w-2xl">
          <H2 id="compare-title">Each layer adds what the last one lacks</H2>
        </Reveal>
        <Reveal className="mt-12 overflow-x-auto rounded-[2px] border-2 border-ink bg-frost shadow-hard">
          <table className="w-full min-w-[36rem] border-collapse text-body-lg">
            <thead>
              <tr>
                <td className="p-4" />
                {LAYERS.map((l, i) => (
                  <th key={l} scope="col" className={cn("p-4 text-center font-semibold", i === 2 && "bg-ink text-canary")}>
                    {l}
                    <span className={cn("block text-caption font-normal", i === 2 ? "text-frost" : "text-graphite")}>{LAYER_NOTES[i]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((r) => (
                <tr key={r.row} className="border-t border-silver">
                  <th scope="row" className="p-4 text-left font-normal">{r.row}</th>
                  {r.cells.map((c, i) => (
                    <td key={i} className={cn("p-3 text-center", i === 2 && "bg-ink text-frost")}>
                      {typeof c === "boolean" ? <Mark yes={c} /> : <span className="text-body">{c}</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
      </section>

      {/* Proof: live on preprod, what was measured, and the transactions anyone can check. */}
      <section id="proof" className="scroll-mt-10 border-t-2 border-ink py-20 sm:py-28">
        <Reveal className="max-w-2xl">
          <H2>Live on Cardano preprod</H2>
          <p className="mt-4 text-body-lg">Real packs paid, used and settled on chain. Measured on Cardano preprod with test funds.</p>
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
        <Reveal className="mt-12 grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <ul className="space-y-3 text-body-lg">
            <li className="flex gap-3">
              <span aria-hidden className="mt-[0.7em] size-1.5 shrink-0 bg-ink" />
              <span>
                Mika&apos;s FX Rates, <TxLink hash={REGISTRY_TX}>registered on Masumi</TxLink>: the registry token minted on chain.
              </span>
            </li>
            <li className="flex gap-3">
              <span aria-hidden className="mt-[0.7em] size-1.5 shrink-0 bg-ink" />
              <span>
                <TxLink hash={SETTLE_TX}>The safe settled Mika&apos;s pack</TxLink>: the seller paid for the signed answers, Hirakumi 3%,
                the rest back to the buyer.
              </span>
            </li>
          </ul>
          <div className="flex flex-col gap-4 sm:flex-row">
            <Link href={DEMO_API} className={buttonVariants({ variant: "outline" })}>See a live status page</Link>
            <Link href={tryHref(DEMO_API_ID)} className={buttonVariants({ variant: "outline" })}>{SECONDARY_CTA}</Link>
          </div>
        </Reveal>
      </section>

      {/* Use cases and economics: who it is for, why packs, and how Hirakumi earns. */}
      <section id="use-cases" aria-labelledby="use-cases-title" className="scroll-mt-10 border-t-2 border-ink py-20 sm:py-28">
        <Reveal className="max-w-2xl">
          <H2 id="use-cases-title">Open an API to agents, without a modernization project</H2>
        </Reveal>
        <Reveal as="ul" stagger={0.06} className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {USE_CASES.map((u) => (
            <li key={u.who} data-reveal className={cn("rb-border rounded-[2px] border-2 bg-frost p-6", u.rb)}>
              <h3 className="text-sub font-semibold">{u.who}</h3>
              <p className="mt-3 text-body-lg text-graphite">{u.what}</p>
            </li>
          ))}
        </Reveal>

        <div className="mt-20 grid gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
          <Reveal>
            <h3 className="text-h-sm font-normal uppercase sm:text-h">100x cheaper than paying for every call</h3>
            <dl className="mt-8 space-y-6 rounded-[2px] border-2 border-ink bg-frost p-6 shadow-hard">
              <div>
                <dt className="text-body-lg">Paying on chain for every answer</dt>
                <dd className="mt-2 w-full rounded-[2px] border-2 border-ink bg-coral px-4 py-3 font-semibold">about 40 cents and a 20 s wait</dd>
              </div>
              <div>
                <dt className="text-body-lg">With a Hirakumi pack (one payment, 100 answers)</dt>
                <dd className="mt-2 flex items-center gap-4 font-semibold">
                  <span aria-hidden className="h-11 w-2 shrink-0 rounded-[2px] border-2 border-ink bg-mint" />
                  about 0.4 cents and no wait
                </dd>
              </div>
              <p className="text-body text-graphite">1 ADA is about $0.28. Answers flow at web speed, about 0.3 s each.</p>
            </dl>
          </Reveal>
          <Reveal stagger={0.08}>
            <h3 className="text-caption font-semibold uppercase tracking-[0.06em] text-graphite lg:mt-3">How Hirakumi makes money</h3>
            <div data-reveal className="mt-6 rounded-[2px] border-2 border-ink bg-frost p-6 shadow-hard">
              <p className="text-sub font-semibold">3% fee, only on good answers</p>
              <p className="mt-2 text-body-lg text-graphite">Paid out by the Cardano contract when a pack settles.</p>
            </div>
            <div data-reveal className="mt-6 rounded-[2px] border-2 border-ink bg-frost p-6 shadow-hard">
              <p className="text-sub font-semibold">A small listing fee per API</p>
              <p className="mt-2 text-body-lg text-graphite">Planned, paid once when a seller lists an API.</p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* FAQ: the real objections, answered plainly. */}
      <section id="faq" className="scroll-mt-10 border-t-2 border-ink py-20 sm:py-28">
        <Reveal className="max-w-2xl">
          <H2>Questions</H2>
        </Reveal>
        <Reveal as="dl" stagger={0.06} className="mt-12 grid gap-x-12 gap-y-10 md:grid-cols-2">
          {FAQ.map((f) => (
            <div key={f.q} data-reveal data-faq className="border-t border-ink pt-5">
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
            You set a promise. AI agents pay only when you keep it. Paste your API&apos;s link, add one DNS record and approve the promise
            and the price.
          </p>
          <div className="mt-8 flex w-full flex-col items-stretch gap-4 sm:w-auto sm:flex-row">
            <ListApiLink className={buttonVariants({ size: "lg" })}>{PRIMARY_CTA}</ListApiLink>
            <Link href={tryHref(DEMO_API_ID)} className={buttonVariants({ variant: "outline", size: "lg" })}>{SECONDARY_CTA}</Link>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
