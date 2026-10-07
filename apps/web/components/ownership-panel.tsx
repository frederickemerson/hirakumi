"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { Elapsed, useElapsed } from "@/components/elapsed";
import { InlineError } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { PhoneWalletConnect } from "@/components/phone-wallet-connect";
import { GetAWallet, useWallets, WalletIcon } from "@/components/wallet-picker";
import { postJson, RequestError } from "@/lib/client-fetch";
import type { ChallengeCheck } from "@/lib/gateway";
import type { PlatformHint } from "@/lib/header-platform";
import { startRouteProgress } from "@/lib/route-progress";
import { connectWallet, signText, walletErrorMessage } from "@/lib/wallet-client";
import { cn } from "@/lib/utils";

/** How often the page checks the seller's API for the header while it is visible. */
export const AUTO_CHECK_MS = 10_000;
export const HEADER = "X-Hirakumi-Verify";

/**
 * One way to send the header, for a common server or host: where to paste it, the code to paste (complete, with the
 * lines around it), and what to do after. Every recipe sends the header on every response, 404s included.
 * `name` is the platform as a person says it ("Vercel"); `label` is the tab ("vercel.json").
 */
export type HeaderSnippet = { id: string; label: string; name: string; steps: string[]; text: string };

/** Ways to send the header, one per common server or host. */
export function headerSnippets(code: string, baseUrl: string): HeaderSnippet[] {
  const path = new URL(baseUrl).pathname;
  const redeploy = "Deploy the change, then run the test below.";
  return [
    {
      id: "express", label: "Express", name: "Express",
      steps: ["Open the file where you create your app (often app.js, server.js or index.js).", "Paste the middleware right after const app = express(), before any routes.", redeploy],
      text: `const app = express();\n\n// Hirakumi ownership check. Before your routes, so every response gets it, 404s too.\napp.use((req, res, next) => {\n  res.set("${HEADER}", "${code}");\n  next();\n});\n\n// ...your routes below`,
    },
    {
      id: "fastapi", label: "FastAPI", name: "FastAPI",
      steps: ["Open the file where you create app = FastAPI() (often main.py).", "Paste the middleware just below that line.", redeploy],
      text: `from fastapi import FastAPI, Request\n\napp = FastAPI()\n\n# Hirakumi ownership check: every response gets it, 404s too.\n@app.middleware("http")\nasync def hirakumi_verify(request: Request, call_next):\n    response = await call_next(request)\n    response.headers["${HEADER}"] = "${code}"\n    return response`,
    },
    {
      id: "flask", label: "Flask", name: "Flask",
      steps: ["Open the file where you create app = Flask(__name__) (often app.py).", "Paste the function just below that line.", redeploy],
      text: `from flask import Flask\n\napp = Flask(__name__)\n\n# Hirakumi ownership check: every response gets it, 404s too.\n@app.after_request\ndef hirakumi_verify(response):\n    response.headers["${HEADER}"] = "${code}"\n    return response`,
    },
    {
      id: "nextjs", label: "Next.js", name: "Next.js",
      steps: [
        "Open next.config.js (or .mjs or .ts) at the root of your project.",
        "Add the headers() function inside the config you already export. If you already set headers in middleware, you can set this one there instead.",
        redeploy,
      ],
      text: `// next.config.js\nmodule.exports = {\n  // ...your existing config\n\n  // Hirakumi ownership check: every response gets it, 404s too.\n  async headers() {\n    return [{ source: "/:path*", headers: [{ key: "${HEADER}", value: "${code}" }] }];\n  },\n};`,
    },
    {
      id: "nginx", label: "nginx", name: "nginx",
      steps: [
        "Open the server block that serves your API (often in /etc/nginx/sites-available/).",
        "Add the add_header line inside it. A location block with any add_header of its own drops the server ones, so add the line to that block too.",
        "Run: sudo nginx -t && sudo systemctl reload nginx",
      ],
      text: `server {\n    # ...your existing config\n\n    # Hirakumi ownership check. "always" sends it on 404s and errors too.\n    add_header ${HEADER} "${code}" always;\n}`,
    },
    {
      id: "vercel", label: "vercel.json", name: "Vercel",
      steps: ["Open vercel.json at the root of your project, or create it.", "Add this headers entry. If the file already has a headers list, add the object inside it.", "Push or run vercel --prod to redeploy, then run the test below."],
      text: `{\n  "headers": [\n    {\n      "source": "/(.*)",\n      "headers": [{ "key": "${HEADER}", "value": "${code}" }]\n    }\n  ]\n}`,
    },
    {
      id: "netlify", label: "Netlify _headers", name: "Netlify",
      steps: [
        "Create a file named _headers (no extension) in your publish folder, for example public/.",
        "Paste these two lines. If the file exists, add them at the end.",
        "Netlify Functions and proxied paths don't read _headers. If your API runs there, set the header in the function's response, or on the server you proxy to.",
        redeploy,
      ],
      text: `/*\n  ${HEADER}: ${code}`,
    },
    {
      id: "cloudflare", label: "Cloudflare", name: "Cloudflare",
      steps: [
        "In the Cloudflare dashboard, open your domain. The DNS record for your API must be proxied (orange cloud).",
        "Go to Rules, then Transform Rules, then Modify Response Header, and create a rule with these settings.",
        "Save. It takes effect in a few seconds, no deploy needed.",
      ],
      text: `Rule name: Hirakumi verify\nIf: ${path === "/" ? "All incoming requests" : `URI Path starts with ${path}`}\nThen: Set static\n  Header name: ${HEADER}\n  Value: ${code}`,
    },
    {
      id: "go", label: "Go", name: "Go (net/http)",
      steps: ["Open the file that starts your server (often main.go).", "Add the hirakumiVerify function and wrap the handler you pass to ListenAndServe with it.", redeploy],
      text: `// Hirakumi ownership check: every response gets it, 404s too.\nfunc hirakumiVerify(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tw.Header().Set("${HEADER}", "${code}")\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\t// ...your routes on mux\n\thttp.ListenAndServe(":8080", hirakumiVerify(mux))\n}`,
    },
    {
      id: "other", label: "Any server", name: "another server",
      steps: [
        "Find where your server or host lets you add a response header to every response: a middleware, an after-request hook, or a headers setting.",
        `Set the header below on every response at ${baseUrl} and below it, errors and 404 pages included.`,
        redeploy,
      ],
      text: `${HEADER}: ${code}`,
    },
  ];
}

/** A prompt the seller pastes into a coding agent (Claude Code, Cursor, …) opened in their API's project. */
export function agentPrompt(code: string, baseUrl: string, platform?: { name: string; evidence: string }): string {
  return [
    `Make this API send the response header ${HEADER} with the value ${code}. Hirakumi uses it to check that I own the API. The value is not a secret.`,
    "",
    "Requirements:",
    `1. Send it on every response at ${baseUrl} and every path below it, errors included (401, 404, 500). Use middleware or the server or hosting config, not a single route.`,
    `2. ${baseUrl} must answer itself, without redirecting somewhere else. A redirect that only adds a slash at the end is fine if it carries the header too.`,
    "3. Keep the header in place, at least until Hirakumi confirms ownership.",
    "4. Change nothing else.",
    ...(platform ? ["", `The server answers with "${platform.evidence}", so it likely runs on ${platform.name}.`] : []),
    "",
    "Find where this project sets up its HTTP server or hosting, make the smallest change, then tell me what you changed and how to deploy it. Once it is deployed, this command should print the header:",
    curlCheck(baseUrl),
  ].join("\n");
}

/** Opens a new Claude chat with the prompt filled in. The prompt holds only the code (public) and the base URL. */
export const claudeUrl = (prompt: string) => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;

/** A shell word: single quotes, any ' inside closed and escaped, so &, |, $ and the like stay part of the URL. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command a seller can run to see the header themselves. */
export function curlCheck(baseUrl: string): string {
  return `curl -s -o /dev/null -D - ${shellQuote(baseUrl)} | grep -i x-hirakumi-verify`;
}

type CheckState =
  | { kind: "waiting" }
  | { kind: "failed"; result: ChallengeCheck }
  | { kind: "error"; text: string };
type SignState = { kind: "idle" } | { kind: "working"; walletId: string; text: string; message?: string } | { kind: "error"; text: string };

/** One sentence naming what the check found. Short, plain, no dashes. */
function headline(r: ChallengeCheck): string {
  switch (r.reason) {
    case "timeout":
    case "unreachable":
    case "blocked":
    case "too_large":
      return "We couldn't reach your API at this URL.";
    case "missing":
      if (r.status && r.status >= 300 && r.status < 400) {
        return `Your API answered ${r.status}, a redirect, without the ${HEADER} header. We only follow a redirect that adds a slash at the end of this URL. Add the header to the redirect too, or answer at this exact URL without redirecting.`;
      }
      return r.status
        ? `Your API answered ${r.status}, but without the ${HEADER} header.`
        : `Your API answered, but without the ${HEADER} header.`;
    case "mismatch":
      return `We found ${HEADER}, but the code doesn't match this API's code.`;
    case "bad_url":
      return "We can't check this base URL.";
    default:
      return "The check didn't pass.";
  }
}
/** The gateway's detail adds facts (why a request failed, what is wrong with the URL) beyond the headline for these. */
const SHOW_DETAIL = new Set<ChallengeCheck["reason"]>(["timeout", "unreachable", "blocked", "too_large", "bad_url", "no_code"]);

/** A short tag for the result card: what kind of failure, in two words at most. */
function verdict(r: ChallengeCheck): string {
  switch (r.reason) {
    case "missing": return "Missing";
    case "mismatch": return "Wrong value";
    case "timeout":
    case "unreachable":
    case "blocked":
    case "too_large": return "Unreachable";
    default: return "Can't check";
  }
}

/** What to do next, for this failure only. */
function nextSteps(r: ChallengeCheck): string[] {
  switch (r.reason) {
    case "missing":
      return [
        "Deploy the change if you haven't yet. We check again every 10 s.",
        "Run the curl command above. If it prints nothing, the header isn't live yet.",
        "A CDN or proxy in front of your API must pass the header on.",
      ];
    case "mismatch":
      return [
        "Copy the header again from the top of this step. The value must match exactly, with no quotes or spaces around it.",
        "Deploy the change. We check again every 10 s.",
      ];
    case "timeout":
    case "unreachable":
    case "blocked":
    case "too_large":
      return [
        "Make sure this URL answers over https from the public internet, not only from your network.",
        "Run the curl command above from another machine to see what we see.",
      ];
    default:
      return ["Fix the base URL in your API's setup, then come back here."];
  }
}

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[2px] border-2 border-ink text-body font-semibold tabular-nums", done ? "bg-mint/50" : "bg-canary")}>
      {done ? "✓" : n}
    </span>
  );
}

function StepHead({ n, done, id, children }: { n: number; done?: boolean; id: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <StepNumber n={n} done={done} />
      <h2 id={id} className="text-body-lg font-semibold">{children}</h2>
    </div>
  );
}

/** A labelled code block with one Copy button. Long lines scroll inside the box, never the page. */
function Snippet({ label, text, copyLabel }: { label: string; text: string; copyLabel?: string }) {
  return (
    <div className="min-w-0 rounded-[2px] border-2 border-ink bg-frost">
      <div className="flex items-center justify-between gap-3 border-b-2 border-ink py-1 pr-1 pl-3">
        <span className="truncate text-caption font-semibold uppercase tracking-[0.04em]">{label}</span>
        <CopyButton value={text} ariaLabel={copyLabel ?? `Copy ${label}`} variant="ghost" />
      </div>
      <pre tabIndex={0} aria-label={label} className="overflow-x-auto bg-ink p-3 text-caption leading-relaxed text-cream"><code>{text}</code></pre>
    </div>
  );
}

function SubHeading({ id, kicker, children }: { id: string; kicker: string; children: ReactNode }) {
  return (
    <h3 id={id} className="flex items-baseline gap-2 text-body font-semibold">
      <span aria-hidden className="text-caption text-bill">{kicker}</span>
      {children}
    </h3>
  );
}

/** The fast way: hand the change to a coding agent, with everything it needs in one prompt. */
function AgentPrompt({ text }: { text: string }) {
  return (
    <section aria-labelledby="agent-prompt" className="space-y-3 rounded-[2px] border-2 border-ink bg-ice p-4">
      <div className="space-y-1">
        <SubHeading id="agent-prompt" kicker="A">Let your AI do it</SubHeading>
        <p className="text-caption text-graphite">
          The prompt has your code, base URL and what to change. Using Claude Code or Cursor? Paste it into your coding agent, open in your API&apos;s project.
        </p>
      </div>
      <pre tabIndex={0} aria-label="Prompt" className="max-h-44 overflow-auto rounded-[2px] bg-ink p-3 text-caption leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-cream"><code>{text}</code></pre>
      <div className="flex flex-wrap gap-3">
        <PromptCopy text={text} />
        <a href={claudeUrl(text)} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Open in Claude
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
    </section>
  );
}

function PromptCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Button size="sm" onClick={copy} className="min-w-32">
      <span aria-live="polite">{copied ? "Copied" : "Copy prompt"}</span>
    </Button>
  );
}

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * The recipes as tabs, one server or host at a time. The tab the headers point to is selected; with no hint,
 * none is, and the seller picks. Arrow keys, Home and End move between tabs.
 */
function SnippetTabs({ snippets, hints, detecting }: { snippets: HeaderSnippet[]; hints: PlatformHint[]; detecting: boolean }) {
  const [picked, setPicked] = useState<string | null>(null);
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const known = hints.filter((h) => snippets.some((x) => x.id === h.id));
  const detectedIds = new Set(known.map((h) => h.id));
  const activeId = picked ?? known[0]?.id ?? null;
  const current = snippets.find((x) => x.id === activeId) ?? null;
  const top = known[0] ? snippets.find((x) => x.id === known[0].id) : undefined;

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = snippets.length - 1;
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i === last ? 0 : i + 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i === 0 ? last : i - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to === null) return;
    e.preventDefault();
    setPicked(snippets[to].id);
    tabs.current[snippets[to].id]?.focus();
  }

  return (
    <div className="space-y-3">
      <p role="status" aria-live="polite" className="flex min-h-6 items-center gap-2 text-caption text-graphite">
        {detecting ? (
          <><Spinner className="size-3" /> Reading your server&apos;s response headers…</>
        ) : top ? (
          <span>
            Your server answers with <code className="rounded-[2px] bg-chalk px-1 text-ink">{known[0].evidence}</code>, so we picked {top.name}. Not right? Pick yours.
          </span>
        ) : (
          <span>Pick where your API runs.</span>
        )}
      </p>
      <div role="tablist" aria-label="Where your API runs" className="flex flex-wrap gap-2">
        {snippets.map((x, i) => {
          const selected = x.id === activeId;
          return (
            <button key={x.id} ref={(el) => { tabs.current[x.id] = el; }} type="button" role="tab" id={`snippet-tab-${x.id}`}
              aria-selected={selected} aria-controls={selected ? "snippet-panel" : undefined}
              aria-label={detectedIds.has(x.id) ? `${x.label} (detected)` : undefined}
              tabIndex={selected || (activeId === null && i === 0) ? 0 : -1}
              onClick={() => setPicked(x.id)} onKeyDown={(e) => onKey(e, i)}
              className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-[2px] border-2 border-ink px-2.5 py-1 text-caption font-semibold",
                selected ? "bg-ink text-cream" : "bg-frost text-ink hover:bg-chalk")}>
              {x.label}
              {detectedIds.has(x.id) && <span aria-hidden className="size-1.5 rounded-full bg-bill" />}
            </button>
          );
        })}
      </div>
      {current && (
        <div role="tabpanel" id="snippet-panel" aria-labelledby={`snippet-tab-${current.id}`} className="space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-body marker:text-graphite">
            {current.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <Snippet label={current.label} text={current.text} copyLabel={`Copy ${current.label} snippet`} />
        </div>
      )}
    </div>
  );
}

/** Resolves the server's platform hints once; null while the probe is still running. */
function usePlatformHints(platforms: Promise<PlatformHint[]> | undefined): PlatformHint[] | null {
  const [hints, setHints] = useState<PlatformHint[] | null>(platforms ? null : []);
  useEffect(() => {
    if (!platforms) return;
    let live = true;
    platforms.then((h) => live && setHints(h), () => live && setHints([]));
    return () => {
      live = false;
    };
  }, [platforms]);
  return hints;
}

/** The check's answer: a tag naming the outcome, then what was found and what to do. Ink text, colour on the rule only. */
function ResultCard({ tone, tag, alert, children }: { tone: "pass" | "fail"; tag: string; alert?: boolean; children: ReactNode }) {
  return (
    <div role={alert ? "alert" : "status"} aria-live={alert ? undefined : "polite"}
      className={cn("space-y-2 rounded-[2px] border-2 border-ink border-l-8 bg-frost p-4 text-body", tone === "pass" ? "border-l-mint" : "border-l-coral")}>
      <Badge variant={tone === "pass" ? "mint" : "destructive"}>{tag}</Badge>
      {children}
    </div>
  );
}

export function OwnershipPanel({ apiId, baseUrl, code, initiallyPassed, beforeSigning, platforms }: {
  apiId: string;
  /** The API's base URL (origin + path_prefix): the address the gateway requests, looking for the header. */
  baseUrl: string;
  /** This API's verification code (server-side, per API). */
  code: string;
  initiallyPassed: boolean;
  /** Shown between the two steps: the optional key for the API (components/upstream-auth-form.tsx). */
  beforeSigning?: ReactNode;
  /** What the API's response headers say it runs on (app/apis/[apiId]/ownership/probe-platform.ts), streamed in. */
  platforms?: Promise<PlatformHint[]>;
}) {
  const router = useRouter();
  const [passed, setPassed] = useState(initiallyPassed);
  const [check, setCheck] = useState<CheckState>({ kind: "waiting" });
  const [inFlight, setInFlight] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [sign, setSign] = useState<SignState>({ kind: "idle" });
  const [signed, setSigned] = useState(false);
  const wallets = useWallets();
  const hints = usePlatformHints(platforms);
  const sinceLast = useElapsed(lastCheckedAt, !passed && lastCheckedAt !== null);
  const checkingFor = useElapsed(startedAt, inFlight);
  const busy = useRef(false);
  const lastStarted = useRef(0);
  const snippets = headerSnippets(code, baseUrl);
  const topHint = hints?.find((h) => snippets.some((x) => x.id === h.id));
  const topSnippet = topHint && snippets.find((x) => x.id === topHint.id);
  const prompt = agentPrompt(code, baseUrl, topHint && topSnippet ? { name: topSnippet.name, evidence: topHint.evidence } : undefined);

  async function runCheck() {
    if (busy.current) return;
    busy.current = true;
    lastStarted.current = Date.now();
    setStartedAt(lastStarted.current);
    setInFlight(true);
    try {
      const result = await postJson<ChallengeCheck>(`/api/apis/${apiId}/ownership/spec-check`, {});
      if (result.ok) {
        setPassed(true);
        setCheck({ kind: "waiting" });
      } else {
        setCheck({ kind: "failed", result });
      }
    } catch (e) {
      setCheck({ kind: "error", text: e instanceof RequestError ? e.message : "Something went wrong. Try again." });
    } finally {
      busy.current = false;
      setInFlight(false);
      setLastCheckedAt(Date.now());
    }
  }
  const runCheckRef = useRef(runCheck);
  runCheckRef.current = runCheck;

  // Check on open, then every AUTO_CHECK_MS while the page is visible, until the code is found.
  useEffect(() => {
    if (passed) return;
    const tick = () => {
      if (isVisible() && Date.now() - lastStarted.current >= AUTO_CHECK_MS - 250) void runCheckRef.current();
    };
    tick();
    const timer = setInterval(tick, AUTO_CHECK_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [passed]);

  async function runSign(walletId: string) {
    try {
      setSign({ kind: "working", walletId, text: "Connecting to your wallet…" });
      const { api, addressHex } = await connectWallet(walletId);
      const challengeUrl = `/api/apis/${apiId}/ownership/wallet-challenge`;
      let challenge: { challengeId: string; message: string };
      try {
        challenge = await postJson(challengeUrl, {});
      } catch (e) {
        // 409: the header pass is older than VERIFY_PASS_TTL_MINUTES. Check the header again instead of a dead end.
        if (!(e instanceof RequestError && e.status === 409)) throw e;
        setSign({ kind: "working", walletId, text: "Checking your header again…" });
        const again = await postJson<ChallengeCheck>(`/api/apis/${apiId}/ownership/spec-check`, {});
        if (!again.ok) {
          setPassed(false);
          setCheck({ kind: "failed", result: again });
          setLastCheckedAt(Date.now());
          setSign({ kind: "error", text: "Your API no longer sends your code. Add the header back, then sign." });
          return;
        }
        challenge = await postJson(challengeUrl, {});
      }
      setSign({ kind: "working", walletId, text: "Approve this message in your wallet. It costs nothing and moves no funds.", message: challenge.message });
      const sig = await signText(api, addressHex, challenge.message);
      setSign({ kind: "working", walletId, text: "Signature received. Checking it…" });
      await postJson(`/api/apis/${apiId}/ownership/verify`, { challengeId: challenge.challengeId, address: addressHex, ...sig });
      setSigned(true);
      setSign({ kind: "working", walletId, text: "Ownership proven. Opening the next step…" });
      startRouteProgress();
      router.push(`/apis/${apiId}/review`);
    } catch (e) {
      setSign({ kind: "error", text: walletErrorMessage(e) });
    }
  }

  const signing = sign.kind === "working";

  return (
    <ol className="space-y-4">
      <li aria-labelledby="own-step-1" className="space-y-4 rounded-[2px] border-2 border-ink bg-frost p-4 sm:p-5">
        <StepHead n={1} done={passed} id="own-step-1">Add your code</StepHead>
        <div className="min-w-0 space-y-6 sm:pl-12">
          <div className="space-y-3">
            <p className="text-body">
              So nobody can sell an API they don&apos;t own. Make your API send this header on every response at its base URL and below it.
            </p>
            <Snippet label="Header" text={`${HEADER}: ${code}`} copyLabel="Copy header" />
            <div className="space-y-1">
              <p className="text-caption font-semibold uppercase tracking-[0.04em] text-graphite">Base URL</p>
              <code className="block rounded-[2px] border-2 border-ink bg-chalk px-3 py-2 text-body break-all">{baseUrl}</code>
            </div>
            <p className="text-caption text-graphite">
              Any status is fine, a 404 page counts. The code proves the folder of this URL, so every endpoint you sell is in it or below it.
            </p>
          </div>

          <AgentPrompt text={prompt} />

          <section aria-labelledby="add-yourself" className="space-y-3">
            <SubHeading id="add-yourself" kicker="B">Or add it yourself</SubHeading>
            <SnippetTabs snippets={snippets} hints={hints ?? []} detecting={hints === null} />
          </section>

          <section aria-labelledby="test-it" className="space-y-3 border-t-2 border-dashed border-silver pt-5">
            <SubHeading id="test-it" kicker="C">Test it</SubHeading>
            <p className="text-body">Run this. It prints the header once your change is live.</p>
            <Snippet label="curl" text={curlCheck(baseUrl)} copyLabel="Copy curl command" />
            {passed ? (
              <ResultCard tone="pass" tag="Found">
                <p className="font-semibold">Found your code.</p>
                <p>Sign with your wallet below to finish.</p>
              </ResultCard>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Button pending={inFlight} pendingLabel="Checking…" onClick={() => void runCheck()}>Check now</Button>
                  <p role="status" aria-live="off" className="min-w-0 flex-1 basis-56 text-caption [overflow-wrap:anywhere] text-graphite tabular-nums">
                    {inFlight
                      ? `Checking ${baseUrl}…${checkingFor ? ` ${checkingFor} s` : ""}`
                      : `${sinceLast !== null ? `Last checked ${sinceLast} s ago. ` : ""}We check every 10 s while this page is open.`}
                  </p>
                </div>
                {check.kind === "failed" && (
                  <ResultCard tone="fail" tag={verdict(check.result)} alert>
                    <p className="font-semibold">{headline(check.result)}</p>
                    {SHOW_DETAIL.has(check.result.reason) && <p>{check.result.detail}</p>}
                    <ul className="list-disc space-y-0.5 pl-5 text-caption">
                      {nextSteps(check.result).map((t) => <li key={t}>{t}</li>)}
                    </ul>
                  </ResultCard>
                )}
                {check.kind === "error" && <InlineError>{check.text}</InlineError>}
              </div>
            )}
          </section>
        </div>
      </li>
      {beforeSigning && <li>{beforeSigning}</li>}
      <li aria-labelledby="own-step-2" className="space-y-3 rounded-[2px] border-2 border-ink bg-frost p-4 sm:p-5">
        <StepHead n={2} done={signed} id="own-step-2">Sign with your wallet</StepHead>
        <div className="min-w-0 space-y-3 sm:pl-12">
          <p className="text-body">
            Your wallet shows a message naming this API and the address buyers will pay. Signing costs nothing and moves no funds.
          </p>
          {!passed && <p className="text-caption text-graphite">Signing unlocks once we find your code.</p>}
          {wallets === null ? (
            <div role="status" aria-label="Looking for wallets" className="flex flex-wrap gap-4">
              <Skeleton className="h-11 w-44" />
              <Skeleton className="h-11 w-44" />
            </div>
          ) : wallets.length === 0 ? (
            <div className="space-y-3">
              {passed && !signed && <PhoneWalletConnect onConnected={(id) => runSign(id)} />}
              <GetAWallet />
            </div>
          ) : (
            <div className="flex flex-wrap gap-4">
              {wallets.map((w) => (
                <Button key={w.id} disabled={!passed || signing || signed} pending={signing && sign.walletId === w.id} onClick={() => runSign(w.id)}>
                  {!(signing && sign.walletId === w.id) && <WalletIcon icon={w.icon} />}
                  Sign with {w.name}
                </Button>
              ))}
              {passed && !signed && <PhoneWalletConnect onConnected={(id) => runSign(id)} />}
            </div>
          )}
          {sign.kind === "working" && (
            <div role="status" aria-live="polite" className="space-y-2 border-l-4 border-sky pl-3 text-body">
              <p>{sign.text} <Elapsed prefix=" " className="text-graphite" /></p>
              {sign.message && <pre className="whitespace-pre-wrap rounded-[2px] bg-ink p-3 text-caption text-cream">{sign.message}</pre>}
            </div>
          )}
          {sign.kind === "error" && <InlineError>{sign.text}</InlineError>}
        </div>
      </li>
    </ol>
  );
}
