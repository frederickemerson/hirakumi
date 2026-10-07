// Property tests for the upstream key leak check and redaction (packages/core upstreamAuth.ts): an answer that
// repeats the seller's key in a common encoding must be caught, and redaction must leave no form of it behind.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { redactUpstreamSecret, textLeaksSecret, upstreamSecretForms, WITHHELD_TEXT } from "@hirakumi/core";
import { runs } from "./runs";

/** A key: 16-48 characters of the alphabet real keys use, with letters and digits. */
const key = fc.stringMatching(/^[A-Za-z0-9_-]{16,48}$/).filter((k) => /\d/.test(k) && /[A-Za-z]/.test(k));
/** Filler that never accidentally contains a key (no letters or digits). */
const filler = fc.stringMatching(/^[ \n{}[\]:,"!.()<>]{0,40}$/);

const uEscape = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const entities = (s: string) => [...s].map((c) => `&#${c.charCodeAt(0)};`).join("");
const hexEntities = (s: string) => [...s].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join("");
const pct = (s: string) => [...s].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
const jsonStr = (s: string) => JSON.stringify(s).slice(1, -1);

const ENCODINGS: [string, (k: string) => string][] = [
  ["raw", (k) => k],
  ["upper", (k) => k.toUpperCase()],
  ["lower", (k) => k.toLowerCase()],
  ["base64", (k) => Buffer.from(k).toString("base64")],
  ["base64url", (k) => Buffer.from(k).toString("base64url")],
  ["hex", (k) => Buffer.from(k).toString("hex")],
  ["percent every char", pct],
  ["encodeURIComponent", encodeURIComponent],
  ["json string", jsonStr],
  ["\\u every char", uEscape],
  ["decimal entities", entities],
  ["hex entities", hexEntities],
  ["base64 of \\u-escaped", (k) => Buffer.from(uEscape(k)).toString("base64")],
  ["percent of base64", (k) => pct(Buffer.from(k).toString("base64"))],
];

/** The body as a real API would send it: the text inside a JSON object, so JSON escaping applies once more. */
const inJson = (s: string) => JSON.stringify({ debug: s });

describe("textLeaksSecret finds the key in common encodings", () => {
  for (const [name, enc] of ENCODINGS) {
    it(`${name}, as is and inside a JSON body`, () => {
      fc.assert(fc.property(key, filler, filler, (k, a, b) => {
        expect(textLeaksSecret(a + enc(k) + b, k)).toBe(true);
        expect(textLeaksSecret(inJson(a + enc(k) + b), k)).toBe(true);
      }), runs(150));
    });
  }

  // Found by the parent's end-to-end gateway attack: the key \u-escaped inside a JSON string reaches the buyer.
  it("the key \\u-escaped, then JSON.stringify'd 1-3 times (nested JSON)", () => {
    fc.assert(fc.property(key, fc.integer({ min: 1, max: 3 }), fc.boolean(), (k, times, escapeFirst) => {
      let s = escapeFirst ? uEscape(k) : k;
      for (let i = 0; i < times; i++) s = JSON.stringify({ v: s });
      expect(textLeaksSecret(s, k)).toBe(true);
    }), runs(300));
  });

  it("the parent's concrete repro", () => {
    const KEY = "hkfake_Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0L";
    expect(textLeaksSecret(JSON.stringify({ debug: uEscape(KEY) }), KEY)).toBe(true);
  });

  it("text without the key is not flagged (no false positives on unrelated keys)", () => {
    fc.assert(fc.property(key, key, filler, (k, other, a) => {
      fc.pre(!other.toLowerCase().includes(k.toLowerCase()) && !k.toLowerCase().includes(other.toLowerCase()));
      // Only the whole key matters here: parts shorter than the key are looked for only after a scheme word or a space.
      expect(textLeaksSecret(a + other + a, k)).toBe(false);
    }), runs(300));
  });
});

describe("redactUpstreamSecret", () => {
  it("leaves no detectable form of the key, and never throws", () => {
    fc.assert(fc.property(key, fc.constantFrom(...ENCODINGS), filler, filler, (k, [, enc], a, b) => {
      const out = redactUpstreamSecret(inJson(a + enc(k) + b), k);
      expect(textLeaksSecret(out, k)).toBe(false);
    }), runs(500));
  });

  it("forms are lowercased, longest first, non-empty; text that only contains forms redacts to [key]s", () => {
    fc.assert(fc.property(key, (k) => {
      const forms = upstreamSecretForms(k);
      for (let i = 1; i < forms.length; i++) expect(forms[i - 1]!.length).toBeGreaterThanOrEqual(forms[i]!.length);
      for (const f of forms) { expect(f).toBe(f.toLowerCase()); expect(f).not.toBe(""); }
      const out = redactUpstreamSecret(forms.join(" | "), k);
      expect(out === WITHHELD_TEXT || !textLeaksSecret(out, k)).toBe(true);
    }), runs(300));
  });

  it("regex-special characters in the key cannot break redaction", () => {
    fc.assert(fc.property(fc.string({ minLength: 8, maxLength: 40 }), filler, (k, a) => {
      fc.pre(k.trim().length >= 8);
      expect(() => redactUpstreamSecret(a + k + a, k)).not.toThrow();
      expect(textLeaksSecret(redactUpstreamSecret(a + k + a, k), k)).toBe(false);
    }), runs(500));
  });

  it("is bounded on large hostile text (1 MB of base64-looking tokens and escapes)", () => {
    const k = "hkfake_Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0L";
    const big = ("QUFBQUFBQUFBQUFBQUFBQUFB \\u0041%41&#65; ").repeat(25_000);
    const t = Date.now();
    textLeaksSecret(big, k);
    redactUpstreamSecret(big, k);
    expect(Date.now() - t).toBeLessThan(10_000);
  });
});
