import type { ApiProgress } from "./progress";

/*
 * The seller guide: what Hirakumi says next to each onboarding step. Client-safe and pure.
 *
 * The step comes from the same authoritative sources as the listing timeline (lib/timeline.ts):
 * the API's state, which only moves forward, and the timeline's current item. Nothing here
 * re-derives progress from page paths or text.
 *
 * Every line must be true of the app as built. Sources, so they stay true:
 * - read/describe "under a minute": app/apis/[apiId]/endpoints/page.tsx waiting copy.
 * - test calls "at least 5 times": app/apis/[apiId]/review/page.tsx waiting copy.
 * - verification file "works once, expires 30 minutes after download": components/ownership-panel.tsx.
 * - signing "costs nothing and moves no funds": a CIP-30 signData message, no transaction.
 * - price locks on publish: lib/repo/packs.ts savePricing only accepts rule_built or priced.
 * - minimum 1 tUSDM: app/api/apis/[apiId]/pricing/route.ts.
 * - registration "about a minute": app/apis/[apiId]/overview/page.tsx waiting copy.
 * - Down means no credits used: the gateway answers 503 and the overview says so.
 */

export type GuideStepKey =
  | "paste"
  | "read"
  | "describe"
  | "choose"
  | "ownership"
  | "test"
  | "promise"
  | "price"
  | "publish"
  | "register"
  | "live"
  | "retired"
  | "failed";

export type GuideFaq = { q: string; a: string };

export type GuideStep = {
  /** Short name for the step, used in the panel header and the thread divider. */
  title: string;
  /** What is happening now. */
  now: string;
  /** What the seller needs to do, or null when there is nothing to do. */
  todo: string | null;
  /** Why it is safe. */
  safe: string;
  /** What comes next. */
  next: string;
  /** How long it usually takes, true numbers only. Null for steps that wait on the seller. */
  time: string | null;
  faqs: GuideFaq[];
};

const FAQ = {
  wallet: {
    q: "Why do you need my wallet?",
    a: "Your wallet address is your account and the place buyers pay. To prove an API is yours you sign one message. Signing costs nothing and moves no funds.",
  },
  promise: {
    q: "What is a promise?",
    a: "A rule a machine can check: the fields a good answer has, their types and how fresh the data must be. A buyer's credit is used only when an answer keeps it.",
  },
  breaks: {
    q: "What if my API breaks?",
    a: "Hirakumi checks it on a schedule. If it stops keeping its promise it shows as Down, buyers get a \"try later\" answer and no credits are used.",
  },
  price: {
    q: "Can I change the price later?",
    a: "Before you publish, as often as you like. Publishing locks it, so buyers always pay the price the listing shows.",
  },
  leave: {
    q: "Can I close this page?",
    a: "Yes. The work runs on our side. Come back any time and this page shows where things are.",
  },
  file: {
    q: "Why a file on my server?",
    a: "Only someone who controls the server can put it there. The file works once and expires 30 minutes after you download it.",
  },
  testCost: {
    q: "Do the test calls cost anything?",
    a: "No. Hirakumi calls your API itself. Nothing is charged and nothing is published.",
  },
  money: {
    q: "Where does the money go?",
    a: "Pack payments settle straight to your wallet on Cardano. Hirakumi never holds your money. Everything here runs on preprod with test funds.",
  },
  readOnly: {
    q: "Which endpoints should I sell?",
    a: "Ones that only read data. Every endpoint starts blocked, and anything that might change data asks you to confirm first.",
  },
} satisfies Record<string, GuideFaq>;

const NOT_PUBLISHED = "Nothing is published until you approve it.";

export const GUIDE: Record<GuideStepKey, GuideStep> = {
  paste: {
    title: "Paste your link",
    now: "Hi, I'm Hirakumi. I'll walk you through listing your API.",
    todo: "Paste the link to your OpenAPI 3 file, then press Continue.",
    safe: NOT_PUBLISHED,
    next: "I read the file and list the endpoints I could sell.",
    time: "Reading usually takes under a minute.",
    faqs: [FAQ.wallet, FAQ.money],
  },
  read: {
    title: "Reading your file",
    now: "I'm reading your OpenAPI file and listing its endpoints.",
    todo: null,
    safe: `${NOT_PUBLISHED} You can leave this page; I keep going.`,
    next: "Next, you choose which endpoints to sell.",
    time: "Usually under a minute.",
    faqs: [FAQ.leave, FAQ.readOnly],
  },
  describe: {
    title: "Describing endpoints",
    now: "I'm writing a short, plain description of each endpoint for buyers.",
    todo: null,
    safe: `${NOT_PUBLISHED} You can leave this page; I keep going.`,
    next: "Next, you choose which endpoints to sell.",
    time: "Usually under a minute.",
    faqs: [FAQ.leave, FAQ.readOnly],
  },
  choose: {
    title: "Choose endpoints",
    now: "Your endpoints are ready.",
    todo: "Tick the ones agents may buy, then press Confirm endpoints.",
    safe: "Every endpoint starts blocked. Nothing is live yet.",
    next: "Next, you prove the API is yours.",
    time: null,
    faqs: [FAQ.readOnly, FAQ.promise],
  },
  ownership: {
    title: "Prove ownership",
    now: "Two checks show this API is yours: a file on your server and one wallet signature.",
    todo: "Download the file, upload it unchanged, press Check, then sign with your wallet.",
    safe: "Signing costs nothing and moves no funds.",
    next: "Then I run test calls on your API.",
    time: "The file expires 30 minutes after you download it.",
    faqs: [FAQ.wallet, FAQ.file],
  },
  test: {
    title: "Test calls",
    now: "I'm calling each endpoint at least 5 times to learn what a good answer looks like.",
    todo: null,
    safe: "Nothing is charged while I test, and nothing is published.",
    next: "Then I write the promise for you to check.",
    time: "Usually a few seconds.",
    faqs: [FAQ.testCost, FAQ.promise],
  },
  promise: {
    title: "Writing the promise",
    now: "The test calls are done. I'm turning them into a promise buyers can rely on.",
    todo: null,
    safe: NOT_PUBLISHED,
    next: "Next, you read the promise and set a price.",
    time: "Usually a few seconds.",
    faqs: [FAQ.promise, FAQ.breaks],
  },
  price: {
    title: "Set a price",
    now: "Your promise is ready.",
    todo: "Read it, set a pack size and a price, then press Publish at this price. A pack costs at least 1 tUSDM.",
    safe: "Nothing is published until you press Publish at this price.",
    next: "Then I register your API on Masumi.",
    time: null,
    faqs: [FAQ.price, FAQ.promise, FAQ.money],
  },
  publish: {
    title: "Publish",
    now: "Your price is saved.",
    todo: "Check the promise and the price once more, then press Publish at this price.",
    safe: "You can still change the price. It locks when you publish.",
    next: "I register your API on Masumi so agents can find it.",
    time: null,
    faqs: [FAQ.price, FAQ.breaks, FAQ.money],
  },
  register: {
    title: "Registering",
    now: "I'm registering your API on the Masumi network.",
    todo: null,
    safe: "You can leave this page; I keep going. If you started in Sokosumi, I tell you there too.",
    next: "Once the registry lists it, your API is Live and agents can buy packs.",
    time: "Usually about a minute.",
    faqs: [FAQ.leave, FAQ.money],
  },
  live: {
    title: "Live",
    now: "Your API is Live. Agents on Masumi and Sokosumi can find it and buy call packs.",
    todo: "Share your public page, or try a paid call yourself.",
    safe: "If your API goes Down, buyers get a \"try later\" answer and no credits are used.",
    next: "Pack sales and downtime show up on this page.",
    time: null,
    faqs: [FAQ.breaks, FAQ.money, FAQ.price],
  },
  retired: {
    title: "Off the market",
    now: "This API is off the market.",
    todo: null,
    safe: "Pack payments already made stay in your wallet.",
    next: "Your sales history stays on the Sales tab.",
    time: null,
    faqs: [FAQ.money],
  },
  failed: {
    title: "Something went wrong",
    now: "A step didn't finish. The reason is on this page.",
    todo: "Fix what it names, then paste the link again.",
    safe: "Nothing was published and nothing was charged.",
    next: "Once it's fixed, I start again from the top.",
    time: null,
    faqs: [FAQ.breaks, FAQ.leave],
  },
};

type ProgressLike = Pick<ApiProgress, "state" | "failure" | "timeline">;

/** The guide step for an API's progress, or "paste" before an API exists. */
export function guideStepFor(progress: ProgressLike | null): GuideStepKey {
  if (!progress) return "paste";
  if (progress.state === "live") return "live";
  if (progress.state === "retired") return "retired";
  const current = progress.timeline.current;
  if (progress.failure || current?.status === "failed") return "failed";
  if (!current) return "read";
  if (current.key === "register") {
    if (progress.state === "registering") return "register";
    return progress.state === "priced" ? "publish" : "price";
  }
  return current.key;
}

/** The guide's lines for a step, in the order they are said. */
export function guideMessages(step: GuideStep): string[] {
  return [step.now, step.todo, step.safe, step.time ? `${step.next} ${step.time}` : step.next].filter(
    (m): m is string => !!m,
  );
}
