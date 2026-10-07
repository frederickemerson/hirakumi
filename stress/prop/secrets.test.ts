// Property tests for the upstream key leak check and redaction (packages/core upstreamAuth.ts): an answer that
// repeats the seller's key in a common encoding must be caught, and redaction must leave no form of it behind.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { randomBytes } from "node:crypto";
import {
  redactUpstreamParts, redactUpstreamSecret, textLeaksAny, textLeaksSecret, upstreamSecretForms, validateUpstreamBag, WITHHELD_TEXT,
} from "@hirakumi/core";
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
/** Base64 of the text broken into lines of `width` characters, as MIME and PEM writers do. */
const mime = (s: string, width: number, eol: string) =>
  Buffer.from(s).toString("base64").replace(new RegExp(`(.{${width}})(?=.)`, "g"), `$1${eol}`);

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
  ["zero-width space between chars", (k) => [...k].join("\u200b")],
  ["soft hyphen and word joiner between chars", (k) => [...k].join("\u00ad\u2060")],
  ["MIME base64 (76 columns, CRLF)", (k) => mime(`${"GET /price?symbol=ADA HTTP/1.1 ".repeat(4)}api_key=${k}&x=1`, 76, "\r\n")],
  ["base64 wrapped every 8 (LF)", (k) => mime(`prefix-${k}-suffix`, 8, "\n")],
  ["UTF-16LE hex", (k) => Buffer.from(k, "utf16le").toString("hex")],
  ["UTF-16BE hex", (k) => Buffer.from(k, "utf16le").swap16().toString("hex")],
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

  it("line-wrapped base64 at any width, any line break, any indentation, around any text", () => {
    const eol = fc.constantFrom("\n", "\r\n", "\r", "\n  ", "\r\n\t");
    fc.assert(fc.property(key, fc.integer({ min: 4, max: 80 }), eol, fc.string({ maxLength: 120 }), fc.string({ maxLength: 120 }), (k, width, br, a, b) => {
      const wrapped = mime(`${a}${k}${b}`, width, br);
      expect(textLeaksSecret(wrapped, k)).toBe(true);
      expect(textLeaksSecret(inJson(wrapped), k)).toBe(true);
    }), runs(300));
  });

  it("any mix of invisible characters (raw, \\u-escaped or entities) between the key's characters", () => {
    const sep = fc.constantFrom("\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u00ad", "&shy;", "&#8203;", "\\u200b");
    fc.assert(fc.property(key, fc.array(sep, { minLength: 1, maxLength: 3 }), (k, seps) => {
      const split = [...k].map((c, i) => c + (i % 2 ? seps[i % seps.length]! : "")).join("");
      expect(textLeaksSecret(split, k)).toBe(true);
      expect(textLeaksSecret(inJson(split), k)).toBe(true);
    }), runs(300));
  });

  it("multi-line text, invisible characters and UTF-16 hex of other keys are not flagged", () => {
    fc.assert(fc.property(key, key, fc.integer({ min: 4, max: 80 }), (k, other, width) => {
      fc.pre(!other.toLowerCase().includes(k.toLowerCase()) && !k.toLowerCase().includes(other.toLowerCase()));
      const text = [mime(`hello ${other}`, width, "\n"), [...other].join("\u200b"), Buffer.from(other, "utf16le").toString("hex")].join("\n");
      expect(textLeaksSecret(text, k)).toBe(false);
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
    const big = ("QUFBQUFBQUFBQUFBQUFBQUFB \\u0041%41&#65; \u200b&shy;\nQUFB\r\n ").repeat(20_000);
    const t = Date.now();
    textLeaksSecret(big, k);
    redactUpstreamSecret(big, k);
    expect(Date.now() - t).toBeLessThan(10_000);
  });
});

/**
 * A bag as the web app renders it (validateUpstreamBag gives what the gateway looks for): 1-4 distinct keys, each sent
 * as is or after "Bearer ", with the leak list every key and every sent value. Some bags leave the leak list empty, so
 * only what the gateway derives itself covers them.
 */
const bag = fc.uniqueArray(key, { minLength: 1, maxLength: 4, selector: (k) => k.toLowerCase() })
  .filter((ks) => ks.every((a) => ks.every((b) => a === b || !a.toLowerCase().includes(b.toLowerCase()))))
  .chain((keys) => fc.tuple(fc.constant(keys), fc.array(fc.boolean(), { minLength: keys.length, maxLength: keys.length }), fc.boolean()))
  .map(([keys, bearer, emptyLeak]) => {
    const values = keys.map((k, i) => (bearer[i] ? `Bearer ${k}` : k));
    const leak = emptyLeak ? [] : [...new Set(keys.flatMap((k, i) => [k, values[i]!]))];
    const { leakParts } = validateUpstreamBag(keys.map((_, i) => ({ in: "header" as const, name: `X-K${i}` })), { values, fixed: [], leak });
    return { keys, leakParts };
  });

describe("textLeaksAny and redactUpstreamParts (sealed bags)", () => {
  it("find any of a bag's keys in every common encoding, as is and inside a JSON body", () => {
    fc.assert(fc.property(bag, fc.nat(), fc.constantFrom(...ENCODINGS), filler, filler, ({ keys, leakParts }, i, [, enc], a, b) => {
      const k = keys[i % keys.length]!;
      expect(textLeaksAny(a + enc(k) + b, leakParts)).toBe(true);
      expect(textLeaksAny(inJson(a + enc(k) + b), leakParts)).toBe(true);
    }), runs(500));
  });

  it("redaction is complete: no part of the bag is left, whichever key the answer repeats and however", () => {
    fc.assert(fc.property(bag, fc.nat(), fc.constantFrom(...ENCODINGS), filler, filler, ({ keys, leakParts }, i, [, enc], a, b) => {
      const k = keys[i % keys.length]!;
      const out = redactUpstreamParts(inJson(a + enc(k) + b + enc(`Bearer ${k}`)), leakParts);
      expect(textLeaksAny(out, leakParts)).toBe(false);
    }), runs(500));
  });

  it("text with only other keys is not flagged", () => {
    fc.assert(fc.property(bag, key, filler, ({ keys, leakParts }, other, a) => {
      fc.pre(keys.every((k) => !other.toLowerCase().includes(k.toLowerCase()) && !k.toLowerCase().includes(other.toLowerCase())));
      expect(textLeaksAny(a + other + a, leakParts)).toBe(false);
    }), runs(300));
  });
});

/** The fastest of `n` runs of each, interleaved so a busy machine slows both alike. */
function fastest(n: number, ...fns: (() => unknown)[]): number[] {
  const best = fns.map(() => Infinity);
  for (let r = 0; r < n; r++) {
    fns.forEach((f, i) => {
      const t = performance.now();
      f();
      best[i] = Math.min(best[i]!, performance.now() - t);
    });
  }
  return best;
}

describe("leak-check CPU budget (a seller can't stall the gateway with a big bag)", () => {
  /** About `mb` MB of JSON answers carrying base64 blobs, MIME-wrapped, with a few escapes: base64-heavy and decodable. */
  const body = (mb: number) => Array.from({ length: Math.round(mb * 1300) }, (_, i) =>
    `{"id":${i},"note":"caf\\u00e9 %41 &#65;","blob":"${randomBytes(570).toString("base64").replace(/(.{76})/g, "$1\\r\\n")}"}\n`).join("");
  const keys = Array.from({ length: 4 }, (_, i) => `hkfake_${i}Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0L`);
  const placements = keys.map((_, i) => ({ in: "header" as const, name: `X-K${i}` }));
  const ONE_MB = body(1);

  it("a max bag as rendered (4 'Bearer K' values, 8 leak entries) costs at most 2x one 'Bearer K' key", () => {
    // Like for like: a value with a space ("Bearer K") makes the check also read "+" as a space, for one key or many.
    const values = keys.map((k) => `Bearer ${k}`);
    const { leakParts } = validateUpstreamBag(placements, { values, fixed: [], leak: keys.flatMap((k, i) => [k, values[i]!]) });
    const [one, many] = fastest(7, () => textLeaksSecret(ONE_MB, values[0]!), () => textLeaksAny(ONE_MB, leakParts));
    expect(many!).toBeLessThanOrEqual(2 * one!);
  });

  it("12 distinct keys (8 leak entries + 4 values) cost at most 2x one key", () => {
    const distinct = Array.from({ length: 12 }, (_, i) => `hk_${i}_${randomBytes(24).toString("base64url")}`);
    const { leakParts } = validateUpstreamBag(placements, { values: distinct.slice(0, 4), fixed: [], leak: distinct.slice(4) });
    expect(leakParts).toHaveLength(12);
    const [one, many] = fastest(7, () => textLeaksSecret(ONE_MB, distinct[0]!), () => textLeaksAny(ONE_MB, leakParts));
    expect(many!).toBeLessThanOrEqual(2 * one!);
  });

  it("grows linearly with the answer: 2 MB costs about twice 1 MB", () => {
    const values = keys.map((k) => `Bearer ${k}`);
    const { leakParts } = validateUpstreamBag(placements, { values, fixed: [], leak: keys.flatMap((k, i) => [k, values[i]!]) });
    const TWO_MB = body(2);
    const [small, big] = fastest(5, () => textLeaksAny(ONE_MB, leakParts), () => textLeaksAny(TWO_MB, leakParts));
    expect(big!).toBeLessThan(3 * small!);
    const t = Date.now();
    redactUpstreamParts(TWO_MB, leakParts);
    expect(Date.now() - t).toBeLessThan(10_000);
  });
});
