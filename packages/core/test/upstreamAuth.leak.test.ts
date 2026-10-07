import { describe, expect, it } from "vitest";
import {
  keyAppearsIn, redactUpstreamParts, redactUpstreamSecret, textLeaksAny, textLeaksSecret, upstreamSecretForms, upstreamSecretParts,
  validateUpstreamBag, WITHHELD_TEXT,
} from "../src/upstreamAuth";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const pct = (s: string) => [...s].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
const uEscape = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const entities = (s: string) => [...s].map((c) => `&#${c.charCodeAt(0)};`).join("");

/** Keys of every shape the leak check treats differently: plain, with escapable characters, schemes, Basic, spaces. */
const VALUES = [
  "sk_live_0123456789abcdef",
  "abc/def+ghi=jkl",
  "Bearer sk_abc123def456",
  "Bearer abc1234",
  "Token tok_9f8e7d6c5b4a",
  `Basic ${b64("alice:s3cr3tpass")}`,
  `Basic ${b64("key_as_user_123:")}`,
  `k<&>"'0123456`,
  "my key x1y2 zz99aabbcc",
];

const ENCODINGS: [string, (s: string) => string][] = [
  ["raw", (s) => s],
  ["upper", (s) => s.toUpperCase()],
  ["base64", b64],
  ["base64url", (s) => Buffer.from(s).toString("base64url")],
  ["hex", (s) => Buffer.from(s).toString("hex")],
  ["utf16le hex", (s) => Buffer.from(s, "utf16le").toString("hex")],
  ["percent", pct],
  ["encodeURIComponent", encodeURIComponent],
  ["\\u", uEscape],
  ["entities", entities],
  ["zero-width", (s) => [...s].join("​")],
  ["MIME", (s) => b64(`${"log line ".repeat(10)}${s} tail`).replace(/(.{20})(?=.)/g, "$1\r\n")],
  ["plus as space", (s) => s.replaceAll("+", " ")],
  ["first half", (s) => s.slice(0, Math.floor(s.length / 2))],
];

const NEGATIVES = ['{"price":0.35,"symbol":"ADA"}', "Bearer token required", "user alice logged in", b64("nothing to see here"), "x".repeat(64)];

/**
 * What the leak check and redaction answer for a fixed corpus, recorded before the multi-part refactor
 * (textLeaksAny, redactUpstreamParts): the hks2 wrappers must keep answering exactly this.
 */
function corpus() {
  return VALUES.map((value) => {
    const texts = [
      ...upstreamSecretParts(value).flatMap((part) => ENCODINGS.map(([name, enc]) => [`${name}(${part})`, `x ${enc(part)} y`] as const)),
      ...NEGATIVES.map((t, i) => [`negative ${i}`, t] as const),
    ];
    return {
      value,
      forms: upstreamSecretForms(value),
      results: texts.map(([label, text]) => ({
        label,
        leaks: textLeaksSecret(text, value),
        inJson: textLeaksSecret(JSON.stringify({ echo: text }), value),
        redacted: redactUpstreamSecret(text, value),
      })),
      appears: keyAppearsIn(value, NEGATIVES),
    };
  });
}

describe("hks2 leak check (corpus)", () => {
  it("textLeaksSecret, redactUpstreamSecret, upstreamSecretForms and keyAppearsIn match the recorded corpus", () => {
    expect(corpus()).toMatchSnapshot();
  });
});

describe("textLeaksAny and redactUpstreamParts (bags: parts taken as they are)", () => {
  const user = "alice_public";
  const password = "s3cr3tpass";
  const basic = `Basic ${b64(`${user}:${password}`)}`;
  // What the gateway looks for in a Basic bag whose leak list was left empty (validateUpstreamBag derives the rest).
  const { leakParts } = validateUpstreamBag([{ in: "header", name: "Authorization" }], { values: [basic], fixed: [], leak: [] });

  it("derives the key after any word before it, so a bare echoed key is withheld and redacted (SSWS, DeepL-Auth-Key)", () => {
    for (const [value, key] of [["SSWS 00abcDEF1234567890", "00abcDEF1234567890"], ["DeepL-Auth-Key k3y-1234-abcd:fx", "k3y-1234-abcd:fx"]] as const) {
      const bag = validateUpstreamBag([{ in: "header", name: "Authorization" }, { in: "header", name: "X-Other" }], { values: [value, "other_secret_1"], fixed: [], leak: [value] });
      expect(bag.leakParts).toContain(key);
      const answer = `{"error":"invalid token ${key}"}`;
      expect(textLeaksAny(answer, bag.leakParts)).toBe(true);
      expect(redactUpstreamParts(answer, bag.leakParts)).not.toContain(key);
    }
  });

  it("does not flag an echoed Basic user name, but flags the password, the pair and Basic b64", () => {
    expect(textLeaksAny(`{"user":"${user}"}`, leakParts)).toBe(false);
    expect(textLeaksAny(`{"error":"wrong password ${password}"}`, leakParts)).toBe(true);
    expect(textLeaksAny(`{"auth":"${user}:${password}"}`, leakParts)).toBe(true);
    expect(textLeaksAny(`{"echo":"${basic}"}`, leakParts)).toBe(true);
    expect(textLeaksAny(`{"echo":"${b64(`${user}:${password}`)}"}`, leakParts)).toBe(true);
    // The hks2 heuristic, by contrast, looks for the user name too.
    expect(textLeaksSecret(`{"user":"${user}"}`, basic)).toBe(true);
  });

  it("flags any of several parts in their encodings, and nothing else", () => {
    const parts = ["sk_first_0123456789", "Bearer sk_second_987654321"];
    expect(textLeaksAny(encodeURIComponent(parts[1]!), parts)).toBe(true);
    expect(textLeaksAny(b64(`x=${parts[0]}`), parts)).toBe(true);
    expect(textLeaksAny(pct(parts[0]!), parts)).toBe(true);
    expect(textLeaksAny('{"price":1}', parts)).toBe(false);
    expect(textLeaksAny("anything", [])).toBe(false);
    expect(textLeaksAny(null, parts)).toBe(false);
  });

  it("equals textLeaksSecret and redactUpstreamSecret when given upstreamSecretParts", () => {
    for (const value of VALUES) {
      for (const text of [`x ${value} y`, pct(value), b64(value), "nothing", ...NEGATIVES]) {
        expect(textLeaksAny(text, upstreamSecretParts(value))).toBe(textLeaksSecret(text, value));
        expect(redactUpstreamParts(text, upstreamSecretParts(value))).toBe(redactUpstreamSecret(text, value));
      }
    }
  });

  it("redacts every part it can locate, and withholds text where a part is only found after decoding", () => {
    expect(redactUpstreamParts(`pw ${password} and ${user}`, leakParts)).toBe(`pw [key] and ${user}`);
    expect(redactUpstreamParts(`sent ${basic}.`, leakParts)).toBe("sent [key].");
    expect(redactUpstreamParts(`pw ${pct(password)}`, leakParts)).toBe(WITHHELD_TEXT);
    expect(redactUpstreamParts("no key", [])).toBe("no key");
  });
});
