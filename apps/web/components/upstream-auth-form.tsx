"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { InlineError, InlineStatus, NoticeList } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteJson, postJson, RequestError } from "@/lib/client-fetch";
import { cn } from "@/lib/utils";

type Placement = "header" | "query";
/** Where the stored key goes and its last 4 characters (lib/repo/upstream-auth.ts). Never the key. */
export type UpstreamAuthSetting = { in: Placement; name: string; hint: string };
/** A stored key as the seller sees it: one header or query parameter, or the parts of a key sent in several places. */
export type UpstreamAuthView = UpstreamAuthSetting | { parts: (UpstreamAuthSetting & { fixed?: boolean })[] };
/** What the OpenAPI file says about the key (the coworker's parse step "authHint"); `parts` when it needs several at once. */
export type UpstreamAuthHintPart = { in: Placement; name: string; prefix?: string };
export type UpstreamAuthHint = UpstreamAuthHintPart & { parts?: UpstreamAuthHintPart[] };
/** The gateway's one test call with a key (POST /internal/apis/:apiId/check-key). Never a body. */
export type KeyCheck = {
  opened: boolean;
  class: "ok" | "accepted_unverified" | "refused" | "forbidden" | "rate_limited" | "timeout" | "echoed" | "unclear" | "unchecked";
  status?: number;
  op?: string;
  reasons?: string[];
  why?: "not_proven" | "no_test_input" | "not_protected";
};

const PLACE_LABEL: Record<Placement, string> = { header: "header", query: "query parameter" };
const QUERY_KEY_WARNING = "A key in the address can leak in logs and error messages. Use a header if your API accepts one.";
const ADDRESS_KEY_WARNING =
  "Part of your API's address looks like a key. A key in the address isn't sealed and can leak in logs and error messages. Put it in a header or query parameter here instead.";
const FIXED_TEXT_NOTE = "Fixed text isn't withheld if your API repeats it. Use it only for public values, such as a version.";

/** "X-API-Key in header, ending in WXYZ". Short keys have no hint. */
export function describeSetting(s: UpstreamAuthSetting): string {
  return `${s.name} in ${s.in === "header" ? "header" : "query"}${s.hint ? `, ending in ${s.hint}` : ""}`;
}

/** "Header apikey ••••WXYZ", "Header Notion-Version (fixed)": one part of a key sent in several places. */
export function describePart(p: UpstreamAuthSetting & { fixed?: boolean }): string {
  return `${p.in === "header" ? "Header" : "Query parameter"} ${p.name}${p.fixed ? " (fixed)" : p.hint ? ` ••••${p.hint}` : ""}`;
}

/** A Bearer style hint: the prefix goes in front of the key when the seller leaves it out. */
export function withPrefix(value: string, prefix: string | undefined): string {
  const v = value.trim();
  if (!prefix || !v || v.toLowerCase().startsWith(prefix.trim().toLowerCase())) return v;
  return `${prefix}${v}`;
}

/**
 * What the test call with the key means for the seller. `ok` is good news, `problem` is the key being refused (the
 * seller can still save it anyway), `note` is anything that didn't prove the key good or bad.
 */
export function describeCheck(check: KeyCheck, egressIps: readonly string[] = []): { tone: "ok" | "problem" | "note"; text: string } {
  const status = check.status ?? 200;
  const on = check.op ? ` on ${check.op}` : "";
  // The gateway couldn't open the saved key (Check key now), so no call was made.
  if (!check.opened) return { tone: "note", text: "The gateway couldn't read this key, so it isn't checked. Try again later, or save the key again." };
  switch (check.class) {
    case "ok":
      return { tone: "ok", text: `Accepted (HTTP ${status}${on}, promise met).` };
    case "accepted_unverified":
      return { tone: "ok", text: `Your API answered ${status} with this key; the promise isn't built yet, so we couldn't check the answer.` };
    case "refused":
      return { tone: "problem", text: `Your API answered ${check.status ?? 401} with this key: typo or revoked key.` };
    case "forbidden": {
      const allowlist = egressIps.length ? `an IP allowlist (${egressIps.join(", ")}, shared by all Hirakumi sellers)` : "an IP allowlist";
      return { tone: "problem", text: `Access blocked (${check.status ?? 403}): the key's permissions, ${allowlist} or a firewall.` };
    }
    case "rate_limited":
      return { tone: "note", text: `Rate-limited (${check.status ?? 429}). Your API asked us to slow down, so the key isn't checked yet.` };
    case "timeout":
      return { tone: "note", text: "Took too long to answer the check, so the key isn't checked yet." };
    case "echoed":
      return { tone: "note", text: "Your API repeated its key in the answer; such answers are withheld." };
    case "unchecked":
      if (check.why === "not_protected") {
        return {
          tone: "note",
          text: `Not checked: your API answered${check.status ? ` ${check.status}` : ""}${on}, but your OpenAPI file doesn't say that endpoint needs the key, so any key would get that answer.`,
        };
      }
      return check.why === "no_test_input"
        ? { tone: "note", text: "Not checked yet: there's no test input to call your API with." }
        : { tone: "note", text: "Saved sealed. Not checked yet: we check it once your address is proven." };
    default:
      if (check.reasons?.length && check.status !== undefined && check.status < 300) {
        return { tone: "note", text: `Answered ${check.status} but the promise failed: ${check.reasons.join("; ")}` };
      }
      // Any reason the gateway gave (a compressed answer it couldn't check, say) is the one thing the seller can act on.
      return { tone: "note", text: `Couldn't tell${check.status ? ` (HTTP ${check.status})` : ""}${check.reasons?.length ? `: ${check.reasons.join("; ")}` : "."}` };
  }
}

type Preset = "single" | "bearer" | "basic" | "twoHeaders" | "keyPlusFixed" | "headerPlusQuery";
const PRESET_LABEL: Record<Preset, string> = {
  single: "One header or query parameter",
  bearer: "Authorization: Bearer and the key",
  basic: "HTTP Basic (user name and password)",
  twoHeaders: "Two headers",
  keyPlusFixed: "A key and fixed text, such as a version header",
  headerPlusQuery: "A header and a query parameter",
};
/** Presets that may need several parts: offered only once the gateway reads them (UPSTREAM_AUTH_V3). */
const MULTI: Preset[] = ["twoHeaders", "keyPlusFixed", "headerPlusQuery"];
/** Basic with a password is sealed as several parts too, so without UPSTREAM_AUTH_V3 only the key as user name is offered. */
const BASIC_KEY_ONLY_LABEL = "HTTP Basic (the key as the user name)";

/** scheme: a word sent before the value ("Bearer"), from the OpenAPI file. */
type Row = { in: Placement; name: string; value: string; fixed: boolean; scheme?: string };
const row = (place: Placement, fixed = false): Row => ({ in: place, name: "", value: "", fixed });
function startRows(p: Preset): Row[] {
  if (p === "keyPlusFixed") return [row("header"), row("header", true)];
  if (p === "headerPlusQuery") return [row("header"), row("query")];
  return [row("header"), row("header")];
}
/** The rows Replace opens with for a stored bag: each part's placement and whether it is fixed text, nothing typed. */
function rowsFor(view: UpstreamAuthView | null, p: Preset): Row[] {
  return view && "parts" in view && view.parts.length >= 2 ? view.parts.map((part) => row(part.in, !!part.fixed)) : startRows(p);
}
/**
 * The preset and rows for a key the OpenAPI file says comes in several parts: two headers, or headers and query
 * parameters. Each row has its name and the word before it filled in; never a value. Null for a single key.
 */
function presetForHint(hint: UpstreamAuthHint | null): { preset: Preset; rows: Row[] } | null {
  if (!hint?.parts || hint.parts.length < 2) return null;
  const rows = hint.parts.map((p) => ({ ...row(p.in), name: p.name, ...(p.prefix?.trim() ? { scheme: p.prefix.trim() } : {}) }));
  return { preset: hint.parts.some((p) => p.in === "query") ? "headerPlusQuery" : "twoHeaders", rows };
}

/** "the header apikey and the header Authorization (Bearer)": where a key in several parts goes. */
function describeHintParts(parts: UpstreamAuthHintPart[]): string {
  return parts.map((p) => `the ${PLACE_LABEL[p.in]} ${p.name}${p.prefix?.trim() ? ` (${p.prefix.trim()})` : ""}`).join(" and ");
}

/** The preset a stored bag most likely came from, so Replace opens on it (empty: secrets are never shown again). */
function presetFor(view: UpstreamAuthView | null): Preset {
  if (!view || !("parts" in view)) return "single";
  if (view.parts.length === 1) return "basic";
  if (view.parts.some((p) => p.fixed)) return "keyPlusFixed";
  return view.parts.some((p) => p.in === "query") ? "headerPlusQuery" : "twoHeaders";
}

type Saved = UpstreamAuthView & { check?: KeyCheck; warnings?: string[] };
type Status = { kind: "idle" } | { kind: "saving" } | { kind: "removing" } | { kind: "checking" } | { kind: "error"; text: string } | { kind: "saved"; text: string };

/** POSTs and returns the status and JSON either way: a 409 carries the check that refused the key. */
async function postForReply(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new RequestError("We couldn't reach Hirakumi. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

const FIELD = "block h-11 w-full rounded-[2px] border-2 border-ink bg-frost px-3 text-body text-ink outline-none transition-colors duration-100 focus-visible:border-sky";

/**
 * The optional key the gateway sends to the seller's API. The key goes to Hirakumi once, is sealed for the
 * gateway, and is never shown again: only where it goes and its last 4 characters come back. Before saving, the
 * gateway tries the key once; a key the API refuses is saved only when the seller says so.
 */
export function UpstreamAuthForm({
  apiId, initial, hint, title = "Does your API need a key?", retriesTests = false, notice, v3 = false, egressIps = [], checkable = false, keyInAddress = false,
}: {
  apiId: string;
  initial: UpstreamAuthView | null;
  hint: UpstreamAuthHint | null;
  title?: string;
  /** After failed test calls: a saved or removed key runs them again, so the page refreshes to show them. */
  retriesTests?: boolean;
  /** A problem with the stored key the gateway reported (the API's address changed since it was saved, say). */
  notice?: string;
  /** Keys sent in several places can be saved (UPSTREAM_AUTH_V3). */
  v3?: boolean;
  /** The gateway's outgoing addresses, for sellers whose API only answers listed IPs (GATEWAY_EGRESS_IPS). */
  egressIps?: string[];
  /** Shows "Check key now" for a stored key. */
  checkable?: boolean;
  /** Part of the API's base URL looks like a key. */
  keyInAddress?: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<UpstreamAuthView | null>(initial);
  const [editing, setEditing] = useState(!initial && hint !== null);
  // A key in several parts is prefilled only where it can be saved (UPSTREAM_AUTH_V3); otherwise the first part.
  const fromHint = v3 && !initial ? presetForHint(hint) : null;
  const [preset, setPreset] = useState<Preset>(fromHint?.preset ?? "single");
  const [place, setPlace] = useState<Placement>((initial && !("parts" in initial) ? initial.in : undefined) ?? hint?.in ?? "header");
  const [name, setName] = useState((initial && !("parts" in initial) ? initial.name : undefined) ?? hint?.name ?? "");
  const [value, setValue] = useState("");
  const [scheme, setScheme] = useState("Bearer");
  const [password, setPassword] = useState("");
  const [rows, setRows] = useState<Row[]>(fromHint?.rows ?? startRows("twoHeaders"));
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [check, setCheck] = useState<KeyCheck | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  /** The body the gateway's check refused, re-sent with saveAnyway when the seller insists. */
  const [refused, setRefused] = useState<Record<string, unknown> | null>(null);
  const busy = status.kind === "saving" || status.kind === "removing" || status.kind === "checking";
  // The prefix only applies to the place and name the OpenAPI file gave it for.
  const prefix = hint?.prefix && place === hint.in && name.trim().toLowerCase() === hint.name.toLowerCase() ? hint.prefix : undefined;
  const presets = (Object.keys(PRESET_LABEL) as Preset[]).filter((p) => v3 || !MULTI.includes(p));
  const errorText = (err: unknown) => (err instanceof RequestError ? err.message : "Something went wrong. Try again.");

  function choose(p: Preset) {
    setPreset(p);
    setValue("");
    setPassword("");
    if (MULTI.includes(p)) setRows(fromHint?.preset === p ? fromHint.rows : startRows(p));
  }

  function body(): Record<string, unknown> {
    switch (preset) {
      case "single":
        return { in: place, name: name.trim(), value: withPrefix(value, prefix) };
      case "bearer":
        return { preset, fields: { key: value.trim(), scheme: scheme.trim() } };
      case "basic":
        return { preset, fields: { username: value.trim(), password: v3 ? password.trim() : "" } };
      default:
        return {
          preset,
          fields: { rows: rows.map((r) => ({ in: r.in, name: r.name.trim(), value: r.value.trim(), fixed: r.fixed, ...(r.scheme ? { scheme: r.scheme } : {}) })) },
        };
    }
  }

  const ready = preset === "single" ? !!name.trim() && !!value.trim()
    : MULTI.includes(preset) ? rows.every((r) => r.name.trim() && r.value.trim())
    : !!value.trim();

  async function send(payload: Record<string, unknown>) {
    setStatus({ kind: "saving" });
    try {
      const reply = await postForReply(`/api/apis/${apiId}/upstream-auth`, payload);
      const data = reply.data as Saved & { code?: string; error?: string };
      if (reply.status === 409 && data.code === "KEY_REFUSED" && data.check) {
        setCheck(data.check);
        setRefused(payload);
        setStatus({ kind: "idle" });
        return;
      }
      if (!reply.ok) throw new RequestError(data.error ?? "Something went wrong. Try again.", reply.status);
      const saved = reply.data as Saved;
      setCurrent("parts" in saved ? { parts: saved.parts } : { in: saved.in, name: saved.name, hint: saved.hint });
      setValue("");
      setPassword("");
      setRows(startRows(preset));
      setEditing(false);
      setRefused(null);
      setCheck(saved.check ?? null);
      setWarnings(saved.warnings ?? []);
      setStatus({ kind: "saved", text: retriesTests ? "Key saved. The test calls run again now." : "Key saved. Hirakumi sends it with every call to your API." });
      if (retriesTests) router.refresh();
    } catch (err) {
      setStatus({ kind: "error", text: errorText(err) });
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setCheck(null);
    setWarnings([]);
    setRefused(null);
    await send(body());
  }

  async function remove() {
    setStatus({ kind: "removing" });
    try {
      await deleteJson(`/api/apis/${apiId}/upstream-auth`);
      setCurrent(null);
      setEditing(false);
      setCheck(null);
      setWarnings([]);
      setStatus({ kind: "saved", text: retriesTests ? "Key removed. The test calls run again now." : "Key removed. Calls to your API go without a key." });
      if (retriesTests) router.refresh();
    } catch (err) {
      setStatus({ kind: "error", text: errorText(err) });
    }
  }

  async function checkNow() {
    setStatus({ kind: "checking" });
    setWarnings([]);
    try {
      const { check: ran } = await postJson<{ check: KeyCheck }>(`/api/apis/${apiId}/upstream-auth/check`, {});
      setCheck(ran);
      setStatus({ kind: "idle" });
    } catch (err) {
      setCheck(null);
      setStatus({ kind: "error", text: errorText(err) });
    }
  }

  function startEditing() {
    setEditing(true);
    setRefused(null);
    setCheck(null);
    setWarnings([]);
    setStatus({ kind: "idle" });
  }

  function replace() {
    startEditing();
    if (current && !("parts" in current)) {
      setPreset("single");
      setPlace(current.in);
      setName(current.name);
    } else {
      const p = v3 ? presetFor(current) : "single";
      choose(p);
      if (MULTI.includes(p)) setRows(rowsFor(current, p));
    }
  }

  function cancel() {
    setEditing(false);
    setValue("");
    setPassword("");
    setRefused(null);
    setCheck(null);
    setStatus({ kind: "idle" });
  }

  const setRow = (i: number, change: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...change } : r)));

  const tab = (p: Placement) => (
    <button
      key={p}
      type="button"
      role="radio"
      aria-checked={place === p}
      disabled={busy}
      onClick={() => setPlace(p)}
      className={cn(
        "cursor-pointer rounded-[2px] border-2 border-ink px-3 py-1.5 text-body font-medium transition-colors duration-100",
        place === p ? "bg-ink text-cream" : "bg-frost text-ink",
      )}
    >
      {p === "header" ? "Header" : "Query parameter"}
    </button>
  );

  const field = (id: string, label: string, input: ReactNode) => (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-body font-medium">{label}</label>
      {input}
    </div>
  );

  const shownCheck = check ? describeCheck(check, egressIps) : null;

  return (
    <section aria-labelledby={`upstream-auth-${apiId}`} className="space-y-3 rounded-[2px] border-2 border-ink bg-frost p-5">
      <h2 id={`upstream-auth-${apiId}`} className="text-body-lg font-semibold">{title}</h2>
      <p className="text-body">
        If your API only answers with a key, add it here. It is encrypted so only the Hirakumi gateway can read it. It is
        sent only to this API&apos;s own address, and it is never shown again.
      </p>
      {retriesTests && <p className="text-body">When you save or remove the key, the test calls run again.</p>}
      {keyInAddress && <p className="text-body" role="note" data-testid="address-key-warning">{ADDRESS_KEY_WARNING}</p>}
      {notice && status.kind !== "saved" && <InlineError>{notice}</InlineError>}
      {hint && !current && (
        <p className="text-caption text-graphite" data-testid="auth-hint">
          {hint.parts && hint.parts.length >= 2
            ? `Your API description asks for a key in several parts at once: ${describeHintParts(hint.parts)}.`
            : `Your API description asks for a key in the ${PLACE_LABEL[hint.in]} ${hint.name}.`}
        </p>
      )}
      {current && !editing && (
        <div className="flex flex-wrap items-center gap-4">
          {"parts" in current ? (
            <ul className="text-body font-medium" data-testid="upstream-auth-current">
              {current.parts.map((p) => <li key={`${p.in}:${p.name}`}>{describePart(p)}</li>)}
            </ul>
          ) : (
            <p className="text-body font-medium" data-testid="upstream-auth-current">{describeSetting(current)}</p>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={replace}>Replace</Button>
          <Button variant="outline" size="sm" disabled={busy} pending={status.kind === "removing"} pendingLabel="Removing…" onClick={() => void remove()}>
            Remove
          </Button>
          {checkable && (
            <Button variant="outline" size="sm" disabled={busy} pending={status.kind === "checking"} pendingLabel="Checking…" onClick={() => void checkNow()}>
              Check key now
            </Button>
          )}
        </div>
      )}
      {!current && !editing && <Button variant="outline" onClick={startEditing}>Add a key</Button>}
      {editing && (
        <form onSubmit={save} aria-busy={busy || undefined} className="space-y-4">
          <div className="space-y-2 sm:max-w-md">
            <label htmlFor={`upstream-auth-preset-${apiId}`} className="block text-body font-medium">How does your API take its key?</label>
            <select id={`upstream-auth-preset-${apiId}`} className={FIELD} value={preset} disabled={busy}
              onChange={(e) => choose(e.target.value as Preset)}>
              {presets.map((p) => <option key={p} value={p}>{p === "basic" && !v3 ? BASIC_KEY_ONLY_LABEL : PRESET_LABEL[p]}</option>)}
            </select>
          </div>
          {preset === "single" && (
            <>
              <div role="radiogroup" aria-label="Where the key goes" className="flex flex-wrap gap-2">
                {tab("header")}
                {tab("query")}
              </div>
              {place === "query" && <p className="text-body" role="note" data-testid="query-key-warning">{QUERY_KEY_WARNING}</p>}
              <div className="grid gap-4 sm:grid-cols-2">
                {field(`upstream-auth-name-${apiId}`, place === "header" ? "Header name" : "Query parameter name",
                  <Input id={`upstream-auth-name-${apiId}`} type="text" autoComplete="off" spellCheck={false}
                    placeholder={place === "header" ? "X-API-Key" : "api_key"} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />)}
                {field(`upstream-auth-value-${apiId}`, "Key",
                  <Input id={`upstream-auth-value-${apiId}`} type="password" autoComplete="off" spellCheck={false}
                    placeholder={prefix ? `${prefix}...` : "Paste the key"} value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} />)}
              </div>
              {prefix && <p className="text-caption text-graphite">We add &quot;{prefix.trim()}&quot; in front of the key if you leave it out.</p>}
            </>
          )}
          {preset === "bearer" && (
            <div className="grid gap-4 sm:grid-cols-2">
              {field(`upstream-auth-scheme-${apiId}`, "Word before the key",
                <Input id={`upstream-auth-scheme-${apiId}`} type="text" autoComplete="off" spellCheck={false}
                  placeholder="Bearer" value={scheme} onChange={(e) => setScheme(e.target.value)} disabled={busy} />)}
              {field(`upstream-auth-value-${apiId}`, "Key",
                <Input id={`upstream-auth-value-${apiId}`} type="password" autoComplete="off" spellCheck={false}
                  placeholder="Paste the key without the word before it" value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} />)}
            </div>
          )}
          {preset === "basic" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {field(`upstream-auth-user-${apiId}`, v3 ? "User name" : "Key (sent as the user name)",
                  <Input id={`upstream-auth-user-${apiId}`} type="password" autoComplete="off" spellCheck={false}
                    value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} />)}
                {v3 && field(`upstream-auth-password-${apiId}`, "Password",
                  <Input id={`upstream-auth-password-${apiId}`} type="password" autoComplete="off" spellCheck={false}
                    value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />)}
              </div>
              <p className="text-caption text-graphite" data-testid="basic-note">
                {v3 ? "Leave the password empty if your API takes the key as the user name."
                  : "Hirakumi sends the key as the user name with an empty password. A user name with a password can't be saved here yet."}
              </p>
            </>
          )}
          {MULTI.includes(preset) && (
            <>
              <ol className="space-y-3">
                {rows.map((r, i) => (
                  <li key={i} className="grid gap-3 sm:grid-cols-[9rem_9rem_1fr_1fr_auto] sm:items-end">
                    {field(`upstream-auth-kind-${apiId}-${i}`, `Part ${i + 1}`,
                      <select id={`upstream-auth-kind-${apiId}-${i}`} className={FIELD} value={r.fixed ? "fixed" : "secret"} disabled={busy}
                        onChange={(e) => setRow(i, { fixed: e.target.value === "fixed" })}>
                        <option value="secret">Secret</option>
                        <option value="fixed">Fixed text</option>
                      </select>)}
                    {field(`upstream-auth-place-${apiId}-${i}`, `Part ${i + 1} goes in`,
                      <select id={`upstream-auth-place-${apiId}-${i}`} className={FIELD} value={r.in} disabled={busy || preset === "twoHeaders"}
                        onChange={(e) => setRow(i, { in: e.target.value as Placement })}>
                        <option value="header">Header</option>
                        <option value="query">Query parameter</option>
                      </select>)}
                    {field(`upstream-auth-row-name-${apiId}-${i}`, `Part ${i + 1} name`,
                      <Input id={`upstream-auth-row-name-${apiId}-${i}`} type="text" autoComplete="off" spellCheck={false}
                        placeholder={r.fixed ? "Notion-Version" : r.in === "header" ? "apikey" : "api_key"}
                        value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} disabled={busy} />)}
                    {field(`upstream-auth-row-value-${apiId}-${i}`, `Part ${i + 1} value`,
                      <Input id={`upstream-auth-row-value-${apiId}-${i}`} type={r.fixed ? "text" : "password"} autoComplete="off" spellCheck={false}
                        placeholder={r.fixed ? "2022-06-28" : "Paste the key, or Bearer and the key"}
                        value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} disabled={busy} />)}
                    {r.scheme && !r.fixed && (
                      <p className="text-caption text-graphite sm:col-span-5">We send &quot;{r.scheme}&quot; and a space before this part&apos;s value. Paste the key alone.</p>
                    )}
                    {rows.length > 2 && (
                      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                        Remove part {i + 1}
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
              {preset !== "twoHeaders" && rows.length < 4 && (
                <Button type="button" variant="outline" size="sm" disabled={busy}
                  onClick={() => setRows((rs) => [...rs, row(preset === "headerPlusQuery" ? "query" : "header")])}>
                  Add a part
                </Button>
              )}
              {rows.some((r) => r.fixed) && <p className="text-body" role="note" data-testid="fixed-text-note">{FIXED_TEXT_NOTE}</p>}
            </>
          )}
          {egressIps.length > 0 && (
            <p className="text-caption text-graphite" data-testid="egress-ips">
              If your API only answers listed IP addresses, allow {egressIps.join(", ")}. All Hirakumi sellers share these addresses.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={busy || !ready} pending={status.kind === "saving" && !refused} pendingLabel="Saving…">
              {current ? "Save the new key" : "Save key"}
            </Button>
            {(current || !hint) && <Button type="button" variant="outline" disabled={busy} onClick={cancel}>Cancel</Button>}
          </div>
        </form>
      )}
      {shownCheck && (
        <div className="flex flex-wrap items-center gap-4" data-testid="key-check">
          {shownCheck.tone === "problem" ? <InlineError>{shownCheck.text}</InlineError>
            : shownCheck.tone === "ok" ? <InlineStatus>{shownCheck.text}</InlineStatus>
            : <p role="note" className="border-l-4 border-sky pl-3 text-body">{shownCheck.text}</p>}
          {refused && (
            <Button type="button" variant="outline" size="sm" disabled={busy} pending={status.kind === "saving"} pendingLabel="Saving…"
              onClick={() => void send({ ...refused, saveAnyway: true })}>
              Save anyway
            </Button>
          )}
        </div>
      )}
      <NoticeList items={warnings} />
      {status.kind === "saved" && <InlineStatus>{status.text}</InlineStatus>}
      {status.kind === "error" && <InlineError>{status.text}</InlineError>}
    </section>
  );
}
