"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Elapsed, useElapsed } from "@/components/elapsed";
import { InlineError, InlineStatus } from "@/components/states";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PhoneWalletConnect } from "@/components/phone-wallet-connect";
import { GetAWallet, useWallets, WalletIcon } from "@/components/wallet-picker";
import { postJson, RequestError } from "@/lib/client-fetch";
import type { ChallengeCheck } from "@/lib/gateway";
import { startRouteProgress } from "@/lib/route-progress";
import { connectWallet, signText, walletErrorMessage } from "@/lib/wallet-client";
import { cn } from "@/lib/utils";

/** How often the page checks the seller's API for the header while it is visible. */
export const AUTO_CHECK_MS = 10_000;
export const HEADER = "X-Hirakumi-Verify";

/**
 * One way to send the header, for a common server or host: where to paste it, the code to paste (complete, with the
 * lines around it), and what to do after. Every recipe sends the header on every response, 404s included.
 */
export type HeaderSnippet = { id: string; label: string; steps: string[]; text: string };

/** Ways to send the header, one per common server or host. */
export function headerSnippets(code: string, baseUrl: string): HeaderSnippet[] {
  const path = new URL(baseUrl).pathname;
  const redeploy = "Deploy the change. We check again every 10 s.";
  return [
    {
      id: "express", label: "Express",
      steps: ["Open the file where you create your app (often app.js, server.js or index.js).", "Paste the middleware right after const app = express(), before any routes.", redeploy],
      text: `const app = express();\n\n// Hirakumi ownership check. Before your routes, so every response gets it, 404s too.\napp.use((req, res, next) => {\n  res.set("${HEADER}", "${code}");\n  next();\n});\n\n// ...your routes below`,
    },
    {
      id: "nginx", label: "nginx",
      steps: [
        "Open the server block that serves your API (often in /etc/nginx/sites-available/).",
        "Add the add_header line inside it. If a location block has its own add_header lines, add it there too, because nginx then ignores the server ones.",
        "Run: sudo nginx -t && sudo systemctl reload nginx",
      ],
      text: `server {\n    # ...your existing config\n\n    # Hirakumi ownership check. "always" sends it on 404s and errors too.\n    add_header ${HEADER} "${code}" always;\n}`,
    },
    {
      id: "vercel", label: "vercel.json",
      steps: ["Open vercel.json at the root of your project, or create it.", "Add this headers entry. If the file already has a headers list, add the object inside it.", "Push or run vercel --prod to redeploy. We check again every 10 s."],
      text: `{\n  "headers": [\n    {\n      "source": "/(.*)",\n      "headers": [{ "key": "${HEADER}", "value": "${code}" }]\n    }\n  ]\n}`,
    },
    {
      id: "netlify", label: "Netlify _headers",
      steps: ["Create a file named _headers (no extension) in your publish folder, for example public/.", "Paste these two lines. If the file exists, add them at the end.", redeploy],
      text: `/*\n  ${HEADER}: ${code}`,
    },
    {
      id: "cloudflare", label: "Cloudflare",
      steps: ["In the Cloudflare dashboard, open your domain.", "Go to Rules, then Transform Rules, then Modify Response Header, and create a rule with these settings.", "Save. It takes effect in a few seconds, no deploy needed."],
      text: `Rule name: Hirakumi verify\nIf: ${path === "/" ? "All incoming requests" : `URI Path starts with ${path}`}\nThen: Set static\n  Header name: ${HEADER}\n  Value: ${code}`,
    },
    {
      id: "nextjs", label: "Next.js",
      steps: ["Open next.config.js (or .mjs or .ts) at the root of your project.", "Add the headers() function inside the config you already export.", redeploy],
      text: `// next.config.js\nmodule.exports = {\n  // ...your existing config\n\n  // Hirakumi ownership check: every response gets it, 404s too.\n  async headers() {\n    return [{ source: "/:path*", headers: [{ key: "${HEADER}", value: "${code}" }] }];\n  },\n};`,
    },
    {
      id: "fastapi", label: "FastAPI",
      steps: ["Open the file where you create app = FastAPI() (often main.py).", "Paste the middleware just below that line.", redeploy],
      text: `from fastapi import FastAPI, Request\n\napp = FastAPI()\n\n# Hirakumi ownership check: every response gets it, 404s too.\n@app.middleware("http")\nasync def hirakumi_verify(request: Request, call_next):\n    response = await call_next(request)\n    response.headers["${HEADER}"] = "${code}"\n    return response`,
    },
    {
      id: "flask", label: "Flask",
      steps: ["Open the file where you create app = Flask(__name__) (often app.py).", "Paste the function just below that line.", redeploy],
      text: `from flask import Flask\n\napp = Flask(__name__)\n\n# Hirakumi ownership check: every response gets it, 404s too.\n@app.after_request\ndef hirakumi_verify(response):\n    response.headers["${HEADER}"] = "${code}"\n    return response`,
    },
    {
      id: "go", label: "Go",
      steps: ["Open the file that starts your server (often main.go).", "Add the hirakumiVerify function and wrap the handler you pass to ListenAndServe with it.", redeploy],
      text: `// Hirakumi ownership check: every response gets it, 404s too.\nfunc hirakumiVerify(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tw.Header().Set("${HEADER}", "${code}")\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\t// ...your routes on mux\n\thttp.ListenAndServe(":8080", hirakumiVerify(mux))\n}`,
    },
    {
      id: "other", label: "Anything else",
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
export function agentPrompt(code: string, baseUrl: string): string {
  return [
    `Make this API send the response header ${HEADER} with the value ${code}. Hirakumi uses it to check that I own the API.`,
    "",
    "Requirements:",
    `1. Send it on every response at ${baseUrl} and every path below it, errors and 404 pages included. Use middleware or the server or hosting config, not a single route.`,
    `2. ${baseUrl} must answer itself, without redirecting somewhere else. A redirect that only adds a slash at the end is fine if it carries the header too.`,
    "3. Change nothing else.",
    "",
    "Find where this project sets up its HTTP server or hosting, make the smallest change, then tell me what you changed and how to deploy it. Once it is deployed, this command should print the header:",
    curlCheck(baseUrl),
  ].join("\n");
}

/** Opens a new Claude chat with the prompt filled in. */
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

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[2px] border-2 border-ink text-body font-semibold tabular-nums", done ? "bg-mint/50" : "bg-canary")}>
      {done ? "✓" : n}
    </span>
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="rounded-[2px] border-2 border-ink">
      <div className="flex items-center justify-between gap-4 border-b-2 border-ink px-3 py-1.5">
        <span className="text-caption font-semibold uppercase tracking-[0.04em]">{label}</span>
        <Button variant="outline" size="xs" onClick={copy} aria-live="polite">{copied ? "Copied" : `Copy ${label}`}</Button>
      </div>
      <pre className="overflow-x-auto bg-ink p-3 text-caption text-cream"><code>{text}</code></pre>
    </div>
  );
}

/** The fast way: hand the change to a coding agent, with everything it needs in one prompt. */
function AgentPrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <section aria-labelledby="agent-prompt" className="space-y-3 rounded-[2px] border-2 border-ink bg-ice p-4">
      <div className="space-y-1">
        <h3 id="agent-prompt" className="text-body font-semibold">Ask your coding agent</h3>
        <p className="text-caption text-graphite">
          Paste this into Claude Code, Cursor or any coding agent open in your API&apos;s project. It has your code and base URL in it.
        </p>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[2px] bg-ink p-3 text-caption text-cream"><code>{text}</code></pre>
      <div className="flex flex-wrap gap-3">
        <Button size="sm" onClick={copy} aria-live="polite">{copied ? "Copied" : "Copy prompt"}</Button>
        <a href={claudeUrl(text)} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Open in Claude
        </a>
      </div>
    </section>
  );
}

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/** The snippets as tabs: one server or host at a time. */
function SnippetTabs({ snippets }: { snippets: HeaderSnippet[] }) {
  const [active, setActive] = useState(snippets[0].id);
  const current = snippets.find((x) => x.id === active) ?? snippets[0];
  return (
    <div className="space-y-2">
      <div role="tablist" aria-label="Where your API runs" className="flex flex-wrap gap-2">
        {snippets.map((x) => (
          <button key={x.id} type="button" role="tab" id={`snippet-tab-${x.id}`} aria-selected={x.id === current.id}
            aria-controls="snippet-panel" onClick={() => setActive(x.id)}
            className={cn("rounded-[2px] border-2 border-ink px-2.5 py-1 text-caption font-semibold",
              x.id === current.id ? "bg-ink text-cream" : "bg-frost text-ink hover:bg-chalk")}>
            {x.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="snippet-panel" aria-labelledby={`snippet-tab-${current.id}`} className="space-y-3">
        <ol className="list-decimal space-y-1 pl-5 text-body">
          {current.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <Snippet label={current.label} text={current.text} />
      </div>
    </div>
  );
}

export function OwnershipPanel({ apiId, baseUrl, code, initiallyPassed, beforeSigning }: {
  apiId: string;
  /** The API's base URL (origin + path_prefix): the address the gateway requests, looking for the header. */
  baseUrl: string;
  /** This API's verification code (server-side, per API). */
  code: string;
  initiallyPassed: boolean;
  /** Shown between the two steps: the optional key for the API (components/upstream-auth-form.tsx). */
  beforeSigning?: ReactNode;
}) {
  const router = useRouter();
  const [passed, setPassed] = useState(initiallyPassed);
  const [check, setCheck] = useState<CheckState>({ kind: "waiting" });
  const [inFlight, setInFlight] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [sign, setSign] = useState<SignState>({ kind: "idle" });
  const [signed, setSigned] = useState(false);
  const wallets = useWallets();
  const sinceLast = useElapsed(lastCheckedAt, !passed && lastCheckedAt !== null);
  const busy = useRef(false);
  const lastStarted = useRef(0);
  const snippets = headerSnippets(code, baseUrl);

  async function runCheck() {
    if (busy.current) return;
    busy.current = true;
    lastStarted.current = Date.now();
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
      const challenge = await postJson<{ challengeId: string; message: string }>(`/api/apis/${apiId}/ownership/wallet-challenge`, {});
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
      <li aria-labelledby="own-step-1" className="flex gap-4 rounded-[2px] border-2 border-ink bg-frost p-5">
        <StepNumber n={1} done={passed} />
        <div className="min-w-0 flex-1 space-y-3">
          <h2 id="own-step-1" className="text-body-lg font-semibold">Add your code</h2>
          <p className="text-body">So nobody can sell an API they don&apos;t own.</p>
          <p className="text-body">Make your API send this header on its responses:</p>
          <Snippet label="Header" text={`${HEADER}: ${code}`} />
          <AgentPrompt text={agentPrompt(code, baseUrl)} />
          <p className="text-body">Or add it yourself:</p>
          <SnippetTabs snippets={snippets} />
          <p className="text-body">It must be on responses at your API&apos;s base URL:</p>
          <code className="block break-all rounded-[2px] bg-ink p-3 text-body text-cream">{baseUrl}</code>
          <p className="text-caption text-graphite">
            Any status is fine, a 404 page counts. The code proves the folder of this URL, so every endpoint you sell is in it or below it.
          </p>
          <p className="text-body">To check it yourself, run:</p>
          <Snippet label="curl" text={curlCheck(baseUrl)} />
          {passed ? (
            <InlineStatus>Found your code.</InlineStatus>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-4">
                <Button variant="outline" pending={inFlight} pendingLabel="Checking…" onClick={() => void runCheck()}>Check now</Button>
                <p role="status" aria-live="off" className="min-w-0 break-all text-caption text-graphite">
                  Checking {baseUrl}…{sinceLast !== null && !inFlight ? ` last checked ${sinceLast} s ago` : ""}
                </p>
              </div>
              {check.kind === "failed" && (
                <div role="alert" className="space-y-2 border-l-4 border-coral pl-3 text-body">
                  <p className="font-semibold">{headline(check.result)}</p>
                  {SHOW_DETAIL.has(check.result.reason) && <p>{check.result.detail}</p>}
                  <ul className="list-disc space-y-0.5 pl-5 text-caption">
                    <li>Send the header on responses at this exact URL. Redirects are not followed, except one that only adds a slash at the end.</li>
                    <li>Any status counts, a 404 page too.</li>
                    <li>Deploy the change. We check again every 10 s.</li>
                  </ul>
                </div>
              )}
              {check.kind === "error" && <InlineError>{check.text}</InlineError>}
            </div>
          )}
        </div>
      </li>
      {beforeSigning && <li>{beforeSigning}</li>}
      <li aria-labelledby="own-step-2" className="flex gap-4 rounded-[2px] border-2 border-ink bg-frost p-5">
        <StepNumber n={2} done={signed} />
        <div className="min-w-0 flex-1 space-y-3">
          <h2 id="own-step-2" className="text-body-lg font-semibold">Sign with your wallet</h2>
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
