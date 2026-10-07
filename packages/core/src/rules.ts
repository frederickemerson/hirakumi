import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { jcs } from "./jcs";
import { sha256Hex } from "./ids";
import type { UpstreamResult } from "./fetch";
import { isJsonMediaType, isMarkupMediaType, isTextMediaType, mediaTypeOf } from "./mediaTypes";

export type RuleDefinition = {
  version: 1;
  status: { min: number; max: number };
  /**
   * The media type every good answer has. For a JSON type (application/json or any +json) the schema checks the
   * parsed body; for a text type (isTextMediaType) it checks the body as one JSON string.
   */
  contentType: string;
  schema: Record<string, unknown>;
};

export { isJsonMediaType, isMarkupMediaType, isTextMediaType, mediaTypeOf } from "./mediaTypes";

export type Verdict = { pass: boolean; reasons: string[] };
/** contentType is the promised media type (the gateway asks the upstream for it). */
export type CompiledRule = { hash: string; contentType: string; check(res: UpstreamResult): Verdict };

// Contract v1.1 B2: 600–3000 s. Price feeds such as CoinGecko lag 1–5 min, and a stale demo answer is 1 h old.
export const DEFAULT_MAX_AGE_SECONDS = 900;
const MAX_CLOCK_SKEW_SECONDS = 60;

/** Age in seconds of an ISO 8601 string or an epoch-seconds number; null when unparseable. */
export function ageSeconds(value: string | number, nowMs: number): number | null {
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? (nowMs - ms) / 1000 : null;
}

const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
ajv.addKeyword({
  keyword: "maxAgeSeconds",
  type: ["string", "number"],
  schemaType: "number",
  errors: false,
  // Runs at validation time, so Date.now() is the moment the response is checked.
  validate: (maxAge: number, data: unknown) => {
    const age = ageSeconds(data as string | number, Date.now());
    // A timestamp more than a minute in the future (a far-off date, or epoch ms read as seconds) is not fresh.
    return age !== null && age >= -MAX_CLOCK_SKEW_SECONDS && age <= maxAge;
  },
});

export function ruleHash(def: RuleDefinition): string {
  return `sha256:${sha256Hex(jcs(def))}`;
}

export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const at = e.instancePath || "/";
    if (e.keyword === "required") {
      return `${e.instancePath}/${(e.params as { missingProperty: string }).missingProperty} is missing`;
    }
    if (e.keyword === "maxAgeSeconds") {
      const age = ageSeconds(e.data as string | number, Date.now());
      return age !== null && age < 0 ? `${at} is in the future` : `${at} is older than ${String(e.schema)}s`;
    }
    if (e.keyword === "not") return `${at} looks like an error response`;
    if (e.keyword === "pattern" && e.schema === NON_BLANK) return `${at} is blank`;
    if (e.keyword === "pattern" && /^#\/allOf\/[1-9]\d*\/pattern$/.test(e.schemaPath)) {
      return `${at} does not contain ${JSON.stringify(unescapeRegExp(String(e.schema)))}`;
    }
    return `${at} ${e.message ?? "is invalid"}`;
  });
}

const cache = new Map<string, CompiledRule>();

export function compileRule(def: RuleDefinition): CompiledRule {
  if (def.version !== 1) throw new Error(`unsupported rule version ${String(def.version)}`);
  const hash = ruleHash(def);
  const hit = cache.get(hash);
  if (hit) return hit;
  const validate: ValidateFunction = ajv.compile(def.schema);
  const compiled: CompiledRule = {
    hash,
    contentType: def.contentType,
    check(res: UpstreamResult): Verdict {
      const reasons: string[] = [];
      if (res.status < def.status.min || res.status > def.status.max) {
        reasons.push(`status ${res.status} is outside ${def.status.min}-${def.status.max}`);
      }
      const ct = mediaTypeOf(res.contentType);
      if (ct !== def.contentType) reasons.push(`content type is ${ct || "missing"}, expected ${def.contentType}`);
      if (reasons.length) return { pass: false, reasons };
      let body: unknown = res.body;
      if (isJsonMediaType(def.contentType)) {
        try {
          body = JSON.parse(res.body);
        } catch {
          return { pass: false, reasons: ["body is not valid JSON"] };
        }
      }
      if (validate(body)) return { pass: true, reasons: [] };
      return { pass: false, reasons: formatSchemaErrors(validate.errors) };
    },
  };
  cache.set(hash, compiled);
  return compiled;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
type JsonKind = "null" | "boolean" | "number" | "string" | "array" | "object";

function kindOf(v: unknown): JsonKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "boolean" || t === "number" || t === "string" || t === "object") return t;
  throw new Error(`not a JSON value: ${t}`);
}

/** JSON Schema that every sample satisfies: required = keys present in all samples. */
export function inferSchema(values: unknown[]): Record<string, unknown> {
  const kinds = [...new Set(values.map(kindOf))].sort();
  if (kinds.length !== 1) return { type: kinds };
  const kind = kinds[0];
  if (kind === "object") {
    const objs = values as Record<string, unknown>[];
    const common = Object.keys(objs[0]).filter((k) => objs.every((o) => Object.hasOwn(o, k))).sort();
    return {
      type: "object",
      required: common,
      properties: Object.fromEntries(common.map((k) => [k, inferSchema(objs.map((o) => o[k]))])),
    };
  }
  if (kind === "array") {
    const items = (values as unknown[][]).flat();
    return items.length ? { type: "array", items: inferSchema(items) } : { type: "array" };
  }
  if (kind === "string") {
    const strings = values as string[];
    const now = Date.now();
    const freshStamp = strings.every((s) => {
      if (!ISO_DATE_TIME.test(s)) return false;
      const age = ageSeconds(s, now);
      return age !== null && Math.abs(age) <= DEFAULT_MAX_AGE_SECONDS;
    });
    return freshStamp ? { type: "string", maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS } : { type: "string" };
  }
  return { type: kind };
}

function acceptsBody(def: RuleDefinition, body: unknown): boolean {
  return compileRule(def).check({ status: 200, contentType: "application/json", body: JSON.stringify(body), latencyMs: 0 }).pass;
}

const isObject = (v: unknown): v is Record<string, unknown> => kindOf(v) === "object";

/** Top-level keys that make a JSON object an error answer when no good sample had them. */
export const JSON_ERROR_KEYS_REFUSED = ["error", "errors", "exception", "fault"];

/** schema with `not: { anyOf: [{ required: [k] }, ...] }` for keys (sorted, once each), or schema itself when keys is empty. */
function refusingKeys(schema: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const sorted = [...new Set(keys)].sort();
  return sorted.length ? { ...schema, not: { anyOf: sorted.map((k) => ({ required: [k] })) } } : schema;
}

/**
 * The promise for JSON samples (inferSchema). When every sample is an object, a top-level error, errors, exception
 * or fault key that no sample had is refused. When the error sample still passes, its own keys that no sample had
 * are refused too; when it passes even then, this throws.
 */
export function inferRule(samples: unknown[], errorSample?: unknown): RuleDefinition {
  if (samples.length === 0) throw new Error("inferRule needs at least one passing sample");
  const objects = samples.every(isObject);
  const seen = new Set(objects ? samples.flatMap((s) => Object.keys(s as Record<string, unknown>)) : []);
  const errorKeys = objects ? JSON_ERROR_KEYS_REFUSED.filter((k) => !seen.has(k)) : [];
  const schema = inferSchema(samples);
  const base: RuleDefinition = { version: 1, status: { min: 200, max: 299 }, contentType: "application/json", schema: refusingKeys(schema, errorKeys) };
  if (errorSample === undefined || !acceptsBody(base, errorSample)) return base;
  if (isObject(errorSample) && objects) {
    const distinctive = Object.keys(errorSample).filter((k) => !seen.has(k));
    if (distinctive.length) {
      const tightened: RuleDefinition = { ...base, schema: refusingKeys(schema, [...errorKeys, ...distinctive]) };
      if (!acceptsBody(tightened, errorSample)) return tightened;
    }
  }
  throw new Error(
    "The promise would accept the error response. Add a passing sample that shows the fields a real answer always has.",
  );
}

export class RuleInferenceError extends Error {}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a body with at least one non-whitespace character. */
const NON_BLANK = "\\S";
/** Patterns take no flags, so a word is matched in any case letter by letter. */
const anyCase = (s: string) => s.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);
/** The HTML not-pattern of rules made before error bodies were refused: still a status-only rule. */
const LEGACY_HTML_PAGE = `^\\s*<(?:!${anyCase("doctype")}\\s+${anyCase("html")}|${anyCase("html")})`;
/**
 * An HTML page or fragment at the start, after optional whitespace: "<!doctype html", "<html", or an "<h1", "<title",
 * "<body" or "<head" tag (a proxy's or framework's error page).
 */
const HTML_PAGE = `^\\s*<(?:!${anyCase("doctype")}\\s+${anyCase("html")}|${anyCase("html")}|(?:${["h1", "title", "body", "head"].map(anyCase).join("|")})(?=[\\s>/]))`;
/** A body shorter than this that starts with an error phrase is an error page, whatever its status. */
export const ERROR_BODY_MAX_LENGTH = 199;
const ERROR_PHRASES = [
  "internal server error", "internal error", "error", "rate limit exceeded", "rate limited", "rate limit", "too many requests",
  "service unavailable", "bad gateway", "gateway timeout", "gateway time-out", "not found", "forbidden", "unauthorized",
  "unauthorised", "maintenance", "timeout", "timed out",
];
/**
 * A short error text: after optional whitespace, leading tags and an HTTP status ("404 Not Found", "HTTP/1.1 503
 * Service Unavailable"), one of ERROR_PHRASES as a whole word. "Errors: 0" and "error_count" do not match.
 */
const ERROR_BODY = `^\\s*(?:<[^>]{0,200}>\\s*)*(?:${anyCase("http")}(?:\\/[0-9.]+)?\\s+)?(?:[45][0-9][0-9](?:\\s*[-:.]\\s*|\\s+))?`
  + `(?:${ERROR_PHRASES.map((p) => p.split(" ").map(anyCase).join("\\s+")).join("|")})(?![A-Za-z0-9_])`;

/**
 * The `not` of text promises made before the long error checks below: an HTML page (unless the promised type is
 * HTML or XML) and a short error text. Kept so those stored promises still read as status-only (isStatusOnlyRule).
 */
function legacyErrorBodyNot(contentType: string): Record<string, unknown> {
  const shortError = { maxLength: ERROR_BODY_MAX_LENGTH, pattern: ERROR_BODY };
  return { anyOf: isMarkupMediaType(contentType) ? [shortError] : [{ pattern: HTML_PAGE }, shortError] };
}

const phraseRe = (p: string) => p.split(" ").map(anyCase).join("\\s+");
const alternatives = (phrases: string[]) => phrases.map(phraseRe).join("|");
/**
 * Phrases that start an error message on their own, whatever follows them: "Rate limit exceeded, retry in 30s ...",
 * "Not Found", "Forbidden". So a report that starts "Forbidden City tours" is refused too; such a listing can start
 * its answers differently.
 */
const LEADING_PHRASES = [
  "internal server error", "service temporarily unavailable", "service unavailable", "bad gateway", "gateway timeout",
  "gateway time-out", "too many requests", "rate limit exceeded", "rate limited", "rate-limited", "rate limit", "quota exceeded",
  "page not found", "not found", "forbidden", "unauthorized", "unauthorised", "method not allowed", "an error occurred",
  "an error has occurred", "an unexpected error", "something went wrong", "exception in thread",
];
/** Words that start an error message as a whole word, whatever follows: "Error in price lookup", "Fatal exception". */
const LEADING_WORDS = ["error", "exception", "fatal"];
/**
 * After a LEADING_WORDS word, what makes it data instead: a CSV or TSV separator right before the next column
 * ("error,count") or a hyphenated word ("Error-free uptime").
 */
const LEADING_WORD_DATA = "(?![,;\\t]\\S|-[A-Za-z])";
/**
 * Phrases and words that start an error message only when a colon, other punctuation, a number or the line end
 * follows: "Server error: x", "Bad request.", "Oops!" but not "Server error rate 0.1%" or "Access denied events 4".
 */
const GUARDED_PHRASES = [
  "internal error", "server error", "application error", "access denied", "permission denied", "bad request", "request timeout",
  "unexpected error", "oops", "failure",
];
const LEADING_WORD_END = "(?=[ \\t]*(?:[:!.(\\[#–—-]|[0-9]|\\r|\\n|$))";
/** An HTTP status line for a redirect or an error: "HTTP/1.1 500 Internal Server Error", "HTTP/2 503". */
const HTTP_STATUS_LINE = `${anyCase("http")}\\/[0-9](?:\\.[0-9])?\\s+[3-5][0-9][0-9](?![0-9])`;
/**
 * An error text of any length, judged by its start (after whitespace): an HTTP status line, an optional status code
 * then an error phrase ("404 page not found", "Internal Server Error ..."), an error word ("Error in ...", "Fatal:
 * ..."), a guarded phrase with punctuation ("Server error: ..."), an exception name ("KeyError: 'x'",
 * "java.lang.NullPointerException"), or Express's "Cannot GET /x".
 */
const LEADING_ERROR = `^\\s*(?:${HTTP_STATUS_LINE}`
  + `|(?:[45][0-9][0-9](?:\\s*[-:.]\\s*|\\s+))?(?:(?:${alternatives(LEADING_PHRASES)})(?![A-Za-z0-9_])`
  + `|(?:${alternatives(LEADING_WORDS)})(?![A-Za-z0-9_])${LEADING_WORD_DATA}`
  + `|(?:${alternatives(GUARDED_PHRASES)})${LEADING_WORD_END})`
  + `|[A-Za-z_][\\w.$]*(?:Error|Exception)(?=:|[ \\t]*(?:\\r|\\n|$))`
  + `|Cannot (?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \\/)`;
/**
 * A stack trace anywhere in the body: Python's "Traceback (most recent call last)", a Node, Java or .NET frame line
 * ("    at foo (/app/x.js:1:2)", "\tat com.x.Y.z(Y.java:10)", "   at System.Net.Http..."), Ruby's "x.rb:12:in `y'",
 * PHP's "Fatal error:" or "Stack trace:\n#0", Java's "Exception in thread" or "java.lang.FooException", Go's
 * "panic: " or "goroutine 1 [running]:" at a line start. Each repeat matches its characters one way only (a path is
 * split into runs between slashes, a .NET argument list stops at its ")"), so a crafted body cannot make the check
 * backtrack for long.
 */
const STACK_TRACE = [
  "Traceback\\s*(?:<[^>]{0,40}>\\s*)?\\(most recent call last\\)",
  "(?:^|\\n)[ \\t]+at (?:async |new )?[A-Za-z_$<][\\w$.<>\\[\\]\\x60,/-]*[ ]?\\([^\\n)]*:[0-9]+",
  "(?:^|\\n)[ \\t]+at (?:async )?(?:file:\\/\\/)?[^\\s()\\/\\\\]*(?:[\\/\\\\][^\\s()\\/\\\\]*)+:[0-9]+:[0-9]+",
  "(?:^|\\n)[ \\t]+at [\\w$.<>\\[\\]\\x60,]+\\([^\\n)]*\\) in [^\\n]*:line [0-9]+",
  "(?:^|\\n)[ \\t]+at (?:System|Microsoft)\\.[\\w.\\x60<>]+\\(",
  "\\.rb:[0-9]+:in [\\x60']",
  "(?:^|\\n)[ \\t]*(?:PHP )?(?:Fatal|Parse) error: ",
  "Stack trace:\\r?\\n#0 ",
  "Exception in thread \"",
  "Caused by: [\\w.$]+(?:Exception|Error)",
  "\\bjava\\.lang\\.[\\w.$]*(?:Exception|Error)\\b",
  "(?:^|\\n)panic: ",
  "(?:^|\\n)goroutine [0-9]+ \\[",
].join("|");

// A JSON string, a JSON text without strings or brackets, and arrays or objects nested up to three deep.
const JSON_STRING = `"(?:[^"\\\\]|\\\\.)*"`;
const JSON_FLAT = `[^"{}\\[\\]]`;
const jsonNested = (inner: string) => `[\\[{](?:${JSON_STRING}|${JSON_FLAT}${inner ? `|${inner}` : ""})*[\\]}]`;
const JSON_NESTED = jsonNested(jsonNested(jsonNested("")));
const JSON_ERROR_KEYS = ["error", "errors", "fault", "exception"].map(anyCase).join("|");
const MESSAGE_KEYS = "message|msg|detail";
const STATUS_KEYS = "status|statusCode|status_code|code";
const META_KEYS = "timestamp|path|requestId|request_id|traceId|trace_id|success|ok|title|type|instance";
const JSON_PAIR = `"(?:${MESSAGE_KEYS}|${STATUS_KEYS}|${META_KEYS})"\\s*:\\s*(?:${JSON_STRING}|[\\w.+-]+)`;
/**
 * A JSON error object sent as text: a top-level key error, errors, fault or exception (keys inside nested values do
 * not count), or an object of only a message, a status or code and metadata such as {"message":"Not Found","status":404}.
 */
const JSON_ERROR = `^\\s*\\{(?:(?:(?:${JSON_STRING}|${JSON_FLAT}|${JSON_NESTED})*,)?\\s*"(?:${JSON_ERROR_KEYS})"\\s*:`
  + `|(?=[^]*"(?:${MESSAGE_KEYS})"\\s*:)(?=[^]*"(?:${STATUS_KEYS})"\\s*:)\\s*${JSON_PAIR}(?:\\s*,\\s*${JSON_PAIR})*\\s*\\}\\s*$)`;

/** A comment that cannot run past its first "-->", so a list of comments is read one way only. */
const MARKUP_COMMENT = "<!--(?:[^-]|-(?!->))*-->";
/** What may come before the first element: XML declarations, processing instructions, comments and a doctype. */
const MARKUP_PROLOG = `^\\s*(?:<\\?[^>]*>\\s*|${MARKUP_COMMENT}\\s*|<!${anyCase("doctype")}[^>]*>\\s*)*`;
/**
 * HTML_PAGE also after an XML declaration or comments ("<?xml ...?><!DOCTYPE html PUBLIC ...>", "<!-- x --><html>"):
 * the HTML check of promises made from now on. HTML_PAGE stays as it was for promises stored before.
 */
const HTML_DOCUMENT = `^\\s*(?:<\\?[^>]*>\\s*|${MARKUP_COMMENT}\\s*)*<(?:!${anyCase("doctype")}\\s+${anyCase("html")}|${anyCase("html")}`
  + `|(?:${["h1", "title", "body", "head"].map(anyCase).join("|")})(?=[\\s>/]))`;
const XML_NAME_PREFIX = "(?:[\\w.-]+:)?";
/** What follows a 4xx or 5xx status in an error title: "<title>404 Not Found", but not "<title>500 new listings". */
const HTTP_REASONS = [
  "error", "bad request", "unauthorized", "forbidden", "not found", "method not allowed", "request timeout", "too many requests",
  "internal server error", "server error", "bad gateway", "service unavailable", "gateway timeout", "gateway time-out",
];
/** What an error or challenge page's title is: "Error", "Application Error", "Just a moment...", "Site Maintenance". */
const TITLE_ERRORS = [
  ...LEADING_PHRASES, ...LEADING_WORDS, ...GUARDED_PHRASES, "exception caught", "could not be found", "just a moment",
  "attention required", "site maintenance", "under maintenance", "down for maintenance", "maintenance mode",
];
/** Phrases that make a page title an error title wherever they are in it, when they end it: "We're sorry, but something went wrong (500)". */
const TITLE_PHRASES = [
  "internal server error", "server error", "application error", "something went wrong", "page not found", "could not be found",
  "service unavailable", "bad gateway", "gateway timeout", "too many requests", "access denied", "exception caught",
];
/** The end of the title, after optional punctuation and a status: "Error</title>", "Just a moment...", "... wrong (500)". */
const TITLE_PUNCTUATION = "[ \\t]*[.!?\\u2026]*[ \\t]*";
const TITLE_CLOSE = `${TITLE_PUNCTUATION}(?:\\(\\s*[0-9]{3}\\s*\\)[ \\t]*)?(?:<|\\r|\\n|$)`;
/** A separator in a title: "|", ":", a dash, or a hyphen with no letter right after it. */
const TITLE_SEPARATOR = "(?:[|:\\u2013\\u2014]|-(?![A-Za-z]))";
/**
 * Markup that says error: an XML document whose root element is error, errors, fault or exception (any case, any
 * namespace prefix, also ErrorResponse), a root with status="error" (or stat, result; error, fail, failed, failure)
 * or a first child <status>error</status>, a SOAP Fault, or an HTML title that says error. A title says error when
 * it starts with an error status ("<title>502 Bad Gateway", also after a separator: "example.com | 522: Connection
 * timed out"), with an exception name followed by ":" or " at" ("<title>OperationalError at /x"), or when an error
 * phrase or word fills it: alone, before a separator ("<title>Error | Example", "Error: ...") or after one ("<title>
 * Example - Page not found"), or a TITLE_PHRASES phrase at its end. Only the root, its first child and the title
 * count: an <errors/> or <fault> element deeper in the data, or a title such as "Error rates", "How to fix 500
 * Internal Server Error | Blog", "TypeError - JavaScript | MDN" or "Dashboard | Error: none", is not an error.
 * The unanchored parts (a SOAP Body, a title tag) read attributes only up to the next "<" or ">", so each start reads
 * its own stretch of the body and a body of "<body" or "<title " repeated is still read in linear time.
 */
const XML_FAIL_VALUE = `(?:${["error", "fail", "failed", "failure"].map(anyCase).join("|")})`;
const MARKUP_ERROR = `${MARKUP_PROLOG}<${XML_NAME_PREFIX}`
  + `(?:${["error", "errors", "fault", "exception"].map(anyCase).join("|")})(?:${anyCase("response")}|_${anyCase("response")})?(?=[\\s>/])`
  + `|${MARKUP_PROLOG}<[\\w.:-]+(?=\\s)(?:[^>"']|"[^"]*"|'[^']*')*?\\s(?:status|stat|result)\\s*=\\s*["']\\s*${XML_FAIL_VALUE}\\s*["']`
  + `|${MARKUP_PROLOG}<[\\w.:-]+(?:\\s[^>]*)?>\\s*<${XML_NAME_PREFIX}status>\\s*${XML_FAIL_VALUE}\\s*<\\/`
  + `|<${XML_NAME_PREFIX}${anyCase("body")}(?:\\s[^<>]*)?>\\s*<${XML_NAME_PREFIX}Fault(?=[\\s>/])|<[\\w.-]+:Fault(?=[\\s>/])`
  + `|<${anyCase("title")}(?:\\s[^<>]*)?>\\s*(?:`
  + `(?:[^<]{0,100}?${TITLE_SEPARATOR}\\s*)?[45][0-9][0-9](?:\\.[0-9]+)?(?:\\s*[-:|.<]|\\s+(?:${alternatives(HTTP_REASONS)})(?![A-Za-z0-9_]))`
  + `|[A-Za-z_][\\w.]*[a-z](?:Error|Exception)(?=\\s*(?::|<|at\\s))`
  + `|(?:${alternatives(TITLE_ERRORS)})(?=${TITLE_CLOSE}|${TITLE_PUNCTUATION}${TITLE_SEPARATOR})`
  + `|[^<]{0,100}?${TITLE_SEPARATOR}\\s*(?:${alternatives(TITLE_ERRORS)})(?=${TITLE_CLOSE}|${TITLE_PUNCTUATION}(?:[|\\u2013\\u2014]|-(?![A-Za-z])))`
  + `|[^<]{0,200}?\\b(?:${alternatives(TITLE_PHRASES)})(?=${TITLE_CLOSE}))`;

/**
 * Error text as the first text of a page or of its body, for a page with no error title: an HTTP status line, a
 * status and its reason ("500 Internal Server Error") or an error phrase or word that fills its element or comes
 * before a separator ("<h1>Internal Server Error</h1>", "<p>Error: ..."), as the title check reads them. A heading
 * such as "<h1>Forbidden City visitor report</h1>" or "<td>404</td>" is data. The body's first text is looked for
 * after at most four tags. Tags are read only up to the next "<", and the tags before the text are read once (a
 * lookahead and a backreference, as an atomic group), so the check stays linear.
 */
const ERROR_TEXT = `(?:${HTTP_STATUS_LINE}`
  + `|[45][0-9][0-9](?:\\.[0-9]+)?(?:\\s*[-:|.]\\s*|\\s+)(?:${alternatives(HTTP_REASONS)})(?![A-Za-z0-9_])`
  + `|(?:${alternatives(TITLE_ERRORS)})(?=${TITLE_CLOSE}|${TITLE_PUNCTUATION}${TITLE_SEPARATOR}))`;
const MARKUP_ERROR_TEXT = `^\\s*(?=((?:<[^<>]*>\\s*)*))\\1${ERROR_TEXT}`
  + `|<${XML_NAME_PREFIX}${anyCase("body")}(?:\\s[^<>]*)?>\\s*(?=((?:<[^<>]*>\\s*){0,4}))\\2${ERROR_TEXT}`;
/** A child of an XML error answer that carries no data: a status, a message or request metadata. */
const XML_META_FIELD = `<${XML_NAME_PREFIX}(?:${MESSAGE_KEYS}|${STATUS_KEYS}|${META_KEYS}|error|reason|description)(?:\\s[^<>]*)?(?:\\/>|>[^<]*<\\/[^<>]*>)\\s*`;
/**
 * An XML document whose root holds only XML_META_FIELD children, one of them a 4xx or 5xx status and one a message
 * ("<response><code>500</code><message>Internal error</message></response>"). A root with any other child is data.
 */
const XML_STATUS_ERROR = `^\\s*(?:<[?!][^<>]*>\\s*)*<[\\w.:-]+(?:\\s[^<>]*)?>\\s*`
  + `(?=(?:${XML_META_FIELD})*?<${XML_NAME_PREFIX}(?:${STATUS_KEYS})(?:\\s[^<>]*)?>\\s*[45][0-9][0-9]\\s*<)`
  + `(?=(?:${XML_META_FIELD})*?<${XML_NAME_PREFIX}(?:${MESSAGE_KEYS}|error|reason|description)[\\s>])`
  + `(?:${XML_META_FIELD})+<\\/[^<>]*>\\s*$`;

/**
 * What a text promise refuses whatever the status, in one `not: { anyOf: [...] }`: an HTML page (unless the promised
 * type is HTML or XML, whose good answers are markup), a short error text (ERROR_BODY), an error text of any length
 * by its start (LEADING_ERROR), a stack trace anywhere (STACK_TRACE), a JSON error object (JSON_ERROR) and markup that
 * says error (MARKUP_ERROR, MARKUP_ERROR_TEXT, XML_STATUS_ERROR: an XML error document is no good answer for plain
 * text either). Promises stored before
 * keep legacyErrorBodyNot.
 */
function errorBodyNot(contentType: string): Record<string, unknown> {
  const shortError = { maxLength: ERROR_BODY_MAX_LENGTH, pattern: ERROR_BODY };
  const long = [
    { pattern: LEADING_ERROR }, { pattern: STACK_TRACE }, { pattern: JSON_ERROR }, { pattern: MARKUP_ERROR },
    { pattern: MARKUP_ERROR_TEXT }, { pattern: XML_STATUS_ERROR },
  ];
  return { anyOf: isMarkupMediaType(contentType) ? [shortError, ...long] : [{ pattern: HTML_DOCUMENT }, shortError, ...long] };
}

// A first line that changes between answers is data, not a header: a date, a time or a number in it.
const DATE_OR_TIME = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}:\d{2}/;
const NUMBER_TOKEN = /^[+\-.,%\d]*\d[+\-.,%\d]*$/;
const MAX_HEADER_LENGTH = 300;

/** True when a shared first line can be a header: short enough, with no date, time or standalone number in it. */
function headerLike(line: string): boolean {
  if (!line.trim() || line.length > MAX_HEADER_LENGTH || DATE_OR_TIME.test(line)) return false;
  const tokens = line.split(/[\s,;|\t]+/).map((t) => t.replace(/^["']+|["']+$/g, "")).filter(Boolean);
  return !tokens.some((t) => NUMBER_TOKEN.test(t));
}

/**
 * The promise for a text answer: the media type, a 2xx status, a body that is not blank, and no error body
 * (errorBodyNot): an HTML page unless the type is HTML or XML, or a short text such as "Rate limit exceeded" or
 * "404 Not Found". When the samples are at least two different bodies, each more than one line, and they all start
 * with the same first line (a CSV header, say) with no date, time or number in it, that line is required too; one
 * body repeated (QA calls the same example several times) does not show which line is a header and which is data.
 * An error answer must still differ by status, media type, that first line or an error body; otherwise this throws.
 */
export function inferTextRule(contentType: string, samples: string[], errorSample?: UpstreamResult): RuleDefinition {
  if (samples.length === 0) throw new Error("inferTextRule needs at least one passing sample");
  const firstLines = samples.map((s) => s.split(/\r?\n/)[0]);
  const header = new Set(samples).size >= 2
    && samples.every((s) => /\r?\n/.test(s.trimEnd())) && firstLines.every((l) => l === firstLines[0]) && headerLike(firstLines[0])
    ? firstLines[0]
    : null;
  const schema: Record<string, unknown> = {
    type: "string", minLength: 1, pattern: header ? `^${escapeRegExp(header)}\\r?\\n` : NON_BLANK, not: errorBodyNot(contentType),
  };
  const def: RuleDefinition = { version: 1, status: { min: 200, max: 299 }, contentType, schema };
  if (errorSample && compileRule(def).check(errorSample).pass) {
    throw new RuleInferenceError("The promise would accept the error response. Make your API answer unknown input with an HTTP 4xx status.");
  }
  return def;
}

const isTextRule = (def: RuleDefinition) => !isJsonMediaType(def.contentType) && def.schema.type === "string";

/**
 * True for a text promise that checks only the status, the media type, a non-blank body and error bodies: no
 * pinned header line and no required phrase. Such a promise is kept by any answer that is not an error, so the
 * seller may want to add a phrase (withRequiredPhrase).
 */
export function isStatusOnlyRule(def: RuleDefinition): boolean {
  if (!isTextRule(def)) return false;
  const { type: _type, minLength, pattern, not, ...rest } = def.schema;
  if (Object.keys(rest).length) return false;
  if (minLength !== undefined && !(typeof minLength === "number" && minLength <= 1)) return false;
  if (pattern !== undefined && pattern !== NON_BLANK) return false;
  if (not === undefined) return true;
  const known = [errorBodyNot(def.contentType), legacyErrorBodyNot(def.contentType), { pattern: LEGACY_HTML_PAGE }].map((n) => jcs(n));
  return known.includes(jcs(not));
}

export const MAX_REQUIRED_PHRASE_LENGTH = 200;

/**
 * A phrase as a pattern that matches it in any case: each letter with a lower and an upper case of one character
 * becomes a class with the phrase's own letter first ("Price" is "[Pp][rR][iI][cC][eE]"), anything else is escaped.
 * Patterns take no flags, so this is how the gateway, the buyer and every JSON Schema validator read it alike.
 */
function anyCasePhrase(p: string): string {
  return [...p].map((c) => {
    const lower = c.toLowerCase();
    const upper = c.toUpperCase();
    if (lower === upper || [...lower].length !== 1 || [...upper].length !== 1) return escapeRegExp(c);
    return `[${c}${c === lower ? upper : lower}]`;
  }).join("");
}

/**
 * A copy of a text promise that also requires the body to contain phrase (trimmed, in any case, 1 to 200
 * characters on one line). Each check is one entry of schema.allOf: the existing pattern first, then the phrases.
 * Phrases added before matched their exact case (an escaped phrase); stored promises keep that. Throws
 * RuleInferenceError for a JSON promise or a bad phrase.
 */
export function withRequiredPhrase(def: RuleDefinition, phrase: string): RuleDefinition {
  if (!isTextRule(def)) throw new RuleInferenceError("A required phrase only works for promises on text answers.");
  const p = phrase.trim();
  if (!p) throw new RuleInferenceError("Type the phrase every good answer contains.");
  if (p.length > MAX_REQUIRED_PHRASE_LENGTH) throw new RuleInferenceError(`The phrase can be at most ${MAX_REQUIRED_PHRASE_LENGTH} characters.`);
  if (/[\r\n]/.test(p)) throw new RuleInferenceError("The phrase must be on one line.");
  const { pattern, allOf, ...schema } = def.schema;
  const checks: unknown[] = Array.isArray(allOf) ? [...allOf] : [];
  if (pattern !== undefined) checks.unshift({ pattern });
  else if (!checks.length) checks.push({ pattern: NON_BLANK });
  const added = { pattern: anyCasePhrase(p) };
  if (!checks.some((c) => jcs(c) === jcs(added))) checks.push(added);
  return { ...def, schema: { ...schema, allOf: checks } };
}

/** The phrases withRequiredPhrase added to a text promise, unescaped, in order. */
export function requiredPhrasesOf(def: RuleDefinition): string[] {
  if (!isTextRule(def) || !Array.isArray(def.schema.allOf)) return [];
  return (def.schema.allOf as { pattern?: unknown }[]).slice(1).flatMap((c) => (typeof c?.pattern === "string" ? [unescapeRegExp(c.pattern)] : []));
}

/**
 * The phrase back from its pattern: an escaped character is itself, a two-letter class (anyCasePhrase) is its
 * first letter. Read left to right, so an escaped "[" from an exact-case phrase is never taken for a class.
 */
const unescapeRegExp = (s: string) => s.replace(/\\(.)|\[(.)(.)\]/gsu, (_, escaped?: string, first?: string) => escaped ?? first ?? "");

/**
 * The promise from real answers: JSON types go through inferRule on the parsed bodies (the media type is the one
 * the answers had, so vendor +json types work), text types through inferTextRule. All good answers must share one
 * media type. Throws RuleInferenceError when no rule can be built.
 */
export function inferRuleFromResponses(good: UpstreamResult[], bad?: UpstreamResult | null): RuleDefinition {
  if (good.length === 0) throw new Error("inferRuleFromResponses needs at least one passing answer");
  const types = [...new Set(good.map((r) => mediaTypeOf(r.contentType)))];
  if (types.length !== 1) throw new RuleInferenceError(`The answers came back with different content types (${types.join(", ")}). A promise needs one.`);
  const ct = types[0];
  if (isJsonMediaType(ct)) {
    const samples = good.map((r) => JSON.parse(r.body) as unknown);
    let errorSample: unknown;
    if (bad) {
      try { errorSample = JSON.parse(bad.body); } catch { errorSample = bad.body; }
    }
    let def: RuleDefinition;
    try {
      def = inferRule(samples, errorSample);
    } catch (e) {
      throw new RuleInferenceError((e as Error).message);
    }
    return { ...def, contentType: ct };
  }
  if (isTextMediaType(ct)) return inferTextRule(ct, good.map((r) => r.body), bad ?? undefined);
  throw new RuleInferenceError(`The answers are ${ct || "of no content type"}, which Hirakumi can't check yet. It checks JSON and text (such as CSV, XML or plain text).`);
}

export const SUGGESTED_PHRASE_MIN_LENGTH = 3;
export const SUGGESTED_PHRASE_MAX_LENGTH = 60;
/** Text between tags, in runs of letters, spaces and common punctuation: digits, tabs, line ends and tags split runs. */
const PHRASE_RUN = /[\p{L},.:;'"!?()&/%_+#*@ -]+/gu;
const PHRASE_TRIM = /^[\s,;/&-]+|[\s,;/&-]+$/g;
/** Words and texts that error answers have, so a phrase with one of them would not tell a good answer from an error. */
const ERROR_WORDS = /error|exception|fail|fatal|invalid|denied|forbidden|unauthori[sz]ed|unavailable|not found|could not be found|timeout|timed out|rate limit|too many|traceback|stack|oops|went wrong|bad gateway|bad request|try again|server|gateway|nginx|apache|cloudflare|vercel|heroku|cannot get|unknown|missing|required|not supported|not allowed|maintenance|request id/i;

/**
 * A phrase to suggest as a required phrase for a status-only text promise: the longest run of whole words (letters
 * and common punctuation, no digits, 3 to 60 characters, on one line, at least two letters together) that every good
 * body contains exactly, that the bad body (the answer to a deliberately wrong input) does not contain in any case,
 * and that has no word typical of error answers ("error", "not found", "server"...). Text inside tags is skipped.
 * Ties go to the earliest in the shortest good body. Null when there is none, and when the good bodies are fewer than
 * two different ones: one answer repeated (QA calling one input five times) does not show which words every answer
 * has and which belong to that input ("Cardano (ADA) price today").
 */
export function suggestPhrase(goodBodies: string[], badBody?: string): string | null {
  if (new Set(goodBodies).size < 2) return null;
  const bad = (badBody ?? "").toLowerCase();
  const source = goodBodies.reduce((a, b) => (b.length < a.length ? b : a)).slice(0, 20_000).replace(/<[^>]*>/g, "\n");
  const inAll = new Map<string, boolean>();
  const everywhere = (t: string) => {
    let hit = inAll.get(t);
    if (hit === undefined) inAll.set(t, (hit = goodBodies.every((b) => b.includes(t))));
    return hit;
  };
  let best: string | null = null;
  for (const run of source.match(PHRASE_RUN) ?? []) {
    const words = [...run.matchAll(/\S+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
    for (let i = 0; i < words.length; i++) {
      for (let j = i; j < words.length; j++) {
        const span = run.slice(words[i].start, words[j].end);
        if (span.length > SUGGESTED_PHRASE_MAX_LENGTH + 4 || !everywhere(span)) break;
        const phrase = span.replace(PHRASE_TRIM, "");
        if (phrase.length < SUGGESTED_PHRASE_MIN_LENGTH || phrase.length > SUGGESTED_PHRASE_MAX_LENGTH || (best && phrase.length <= best.length)) continue;
        if (!/\p{L}{2}/u.test(phrase) || ERROR_WORDS.test(phrase) || bad.includes(phrase.toLowerCase())) continue;
        best = phrase;
      }
    }
  }
  return best;
}
