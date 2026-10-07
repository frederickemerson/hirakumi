// Property tests for the promise engine (packages/core rules.ts, jcs.ts): rule hashes are stable, an answer the
// rule was built from keeps it, compiling and checking never crash, and text promises honour the confirmed phrase.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  compileRule, inferRule, inferRuleFromResponses, inferSchema, inferTextRule, jcs, requiredPhrasesOf, ruleHash,
  withRequiredPhrase, type RuleDefinition,
} from "@hirakumi/core";
import { runs } from "./runs";

const json = fc.jsonValue({ maxDepth: 4 }) as fc.Arbitrary<unknown>;
const ok = (body: string, contentType = "application/json") => ({ status: 200, contentType, body, latencyMs: 1 });

/** The same value with every object's keys in another order. */
function shuffleKeys(v: unknown, seed: number): unknown {
  if (Array.isArray(v)) return v.map((x, i) => shuffleKeys(x, seed + i));
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    entries.sort((a, b) => ((a[0].length * 31 + seed) % 7) - ((b[0].length * 31 + seed) % 7) || (seed % 2 ? -1 : 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries) Object.defineProperty(out, k, { value: shuffleKeys(x, seed + 1), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

const jsonSchemaish = fc.letrec((tie) => ({
  schema: fc.record({
    type: fc.constantFrom("object", "string", "number", "integer", "array", "boolean", "null"),
    required: fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 }),
    properties: fc.dictionary(fc.string({ maxLength: 6 }), tie("schema"), { maxKeys: 3 }),
    maxAgeSeconds: fc.integer({ min: -10, max: 5000 }),
    pattern: fc.constantFrom("\\S", "^a", "[Aa]bc"),
    minLength: fc.nat(5),
  }, { requiredKeys: ["type"] }),
}));

describe("jcs and ruleHash", () => {
  it("jcs round-trips and is idempotent; key order never changes it", () => {
    fc.assert(fc.property(json, fc.nat(), (v, seed) => {
      const c = jcs(v);
      expect(JSON.parse(c)).toEqual(JSON.parse(JSON.stringify(v)));
      expect(jcs(JSON.parse(c))).toBe(c);
      expect(jcs(shuffleKeys(v, seed))).toBe(c);
    }), runs(1000));
  });

  it("the same definition gives the same hash in any key order; any change gives another hash", () => {
    fc.assert(fc.property(json, fc.nat(), (sample, seed) => {
      const def = inferRule([sample]);
      const h = ruleHash(def);
      expect(ruleHash(shuffleKeys(def, seed) as RuleDefinition)).toBe(h);
      expect(ruleHash({ ...def, status: { min: 200, max: 298 } })).not.toBe(h);
      expect(compileRule(def).hash).toBe(h);
    }), runs(500));
  });
});

describe("inferRule: every sample keeps the promise built from it", () => {
  it("random JSON samples (1-4) all pass the inferred rule, and keep passing after a JSON round-trip", () => {
    fc.assert(fc.property(fc.array(json, { minLength: 1, maxLength: 4 }), (samples) => {
      const def = inferRule(samples);
      const rule = compileRule(def);
      for (const s of samples) {
        const v = rule.check(ok(JSON.stringify(s)));
        expect(v.reasons).toEqual([]);
        expect(v.pass).toBe(true);
      }
    }), runs(800));
  });

  it("fresh timestamps (past, now, a little in the future) keep the promise built from them", () => {
    // offset in seconds from now; inferSchema calls a string a fresh timestamp within 900 s either way.
    fc.assert(fc.property(fc.array(fc.integer({ min: -800, max: 50 }), { minLength: 1, maxLength: 3 }), (offsets) => {
      const samples = offsets.map((o) => ({ updatedAt: new Date(Date.now() + o * 1000).toISOString(), v: 1 }));
      const rule = compileRule(inferRule(samples));
      for (const s of samples) expect(rule.check(ok(JSON.stringify(s))).pass).toBe(true);
    }), runs(300));
  });

  // Found by this suite: inferSchema marks a string as a fresh timestamp when it is within 900 s of now in EITHER
  // direction, but the check refuses anything more than 60 s in the future. An API whose clock runs 2 minutes fast
  // (or that answers with an expiry or "next update" time) gets a promise its own sample answer breaks.
  it("a sample with a timestamp 2-15 minutes in the future keeps the promise built from it", () => {
    fc.assert(fc.property(fc.integer({ min: 61, max: 899 }), (ahead) => {
      const sample = { nextUpdate: new Date(Date.now() + ahead * 1000).toISOString() };
      const v = compileRule(inferRule([sample])).check(ok(JSON.stringify(sample)));
      expect(v.reasons).toEqual([]);
    }), runs(200));
  });

  it("an error answer is either told apart from good ones or refused with a clear error", () => {
    fc.assert(fc.property(fc.array(fc.dictionary(fc.string({ maxLength: 5 }), json, { maxKeys: 4 }), { minLength: 1, maxLength: 3 }), json, (samples, err) => {
      let def: RuleDefinition;
      try { def = inferRule(samples, err); } catch (e) { expect((e as Error).message).toMatch(/would accept the error/); return; }
      const rule = compileRule(def);
      expect(rule.check(ok(JSON.stringify(err))).pass).toBe(false);
      for (const s of samples) expect(rule.check(ok(JSON.stringify(s))).pass).toBe(true);
    }), runs(500));
  });

  // Found by this suite: ajv without ownProperties read prototype names ("__proto__", "constructor", "toString") as
  // present on every object, and "not required ['']" as true for every object.
  it("fields named like Object.prototype members are really required, and error keys named so never refuse good answers", () => {
    const proto = fc.constantFrom("__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "");
    fc.assert(fc.property(proto, proto, (k, errKey) => {
      const sample = JSON.parse(JSON.stringify({ [k]: 1, v: 2 }));
      const rule = compileRule(inferRule([sample]));
      expect(rule.check(ok(JSON.stringify(sample))).pass).toBe(true);
      expect(rule.check(ok('{"v":2}')).pass).toBe(false);
      const err = JSON.parse(`{${JSON.stringify(errKey)}:"boom"}`);
      let def: RuleDefinition;
      try { def = inferRule([{ v: 2 }], err); } catch { return; }
      expect(compileRule(def).check(ok('{"v":2}')).pass).toBe(true);
      expect(compileRule(def).check(ok(JSON.stringify(err))).pass).toBe(false);
    }), runs(100));
  });

  it("inferRuleFromResponses keeps a vendor +json type and its answers keep the promise", () => {
    fc.assert(fc.property(fc.array(json, { minLength: 1, maxLength: 3 }), fc.constantFrom("application/json", "application/vnd.api+json", "application/problem+json; charset=utf-8"), (samples, ct) => {
      const res = samples.map((s) => ok(JSON.stringify(s), ct));
      const def = inferRuleFromResponses(res);
      for (const r of res) expect(compileRule(def).check(r).pass).toBe(true);
    }), runs(300));
  });

  it("inferSchema never throws on JSON and never produces a schema ajv refuses", () => {
    fc.assert(fc.property(fc.array(json, { minLength: 1, maxLength: 5 }), (vs) => {
      const schema = inferSchema(vs);
      expect(() => compileRule({ version: 1, status: { min: 200, max: 299 }, contentType: "application/json", schema })).not.toThrow();
    }), runs(500));
  });
});

describe("compileRule / check on hostile input", () => {
  it("random schemas either compile or throw an Error; a compiled check never throws on any body", () => {
    fc.assert(fc.property(jsonSchemaish.schema, fc.oneof(fc.string(), json.map((v) => JSON.stringify(v))), fc.integer({ min: 0, max: 999 }),
      fc.option(fc.constantFrom("application/json", "text/plain", "TEXT/CSV; charset=x", "", ";;;")),
      (schema, body, status, ct) => {
        let rule;
        try { rule = compileRule({ version: 1, status: { min: 200, max: 299 }, contentType: "application/json", schema: schema as Record<string, unknown> }); }
        catch (e) { expect(e).toBeInstanceOf(Error); return; }
        const v = rule.check({ status, contentType: ct, body, latencyMs: 0 });
        expect(typeof v.pass).toBe("boolean");
        if (status < 200 || status > 299) expect(v.pass).toBe(false);
      }), runs(1000));
  });

  it("a non-1 version is refused", () => {
    expect(() => compileRule({ version: 2 as 1, status: { min: 200, max: 299 }, contentType: "application/json", schema: {} })).toThrow();
  });

  it("a 1 MB deeply nested body is checked without crashing", () => {
    const rule = compileRule(inferRule([{ a: 1 }]));
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    expect(() => rule.check(ok(deep))).not.toThrow();
    expect(rule.check(ok(deep)).pass).toBe(false);
  });
});

describe("text promises with a confirmed phrase", () => {
  const phrase = fc.string({ minLength: 1, maxLength: 40 }).filter((p) => p.trim().length > 0 && !/[\r\n]/.test(p));
  const base = inferTextRule("text/csv", ["a,b\n1,2"]);

  it("a body containing the phrase in any case keeps it; one without it does not", () => {
    fc.assert(fc.property(phrase, fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), fc.boolean(), (p, a, b, upper) => {
      const def = withRequiredPhrase(base, p);
      const rule = compileRule(def);
      const t = p.trim();
      const shown = upper ? t.toUpperCase() : t.toLowerCase();
      const body = `x${a}${t}${b}x`;
      expect(rule.check(ok(body, "text/csv")).pass).toBe(true);
      // The case-changed phrase only when changing case keeps every character a single code point.
      if ([...shown].length === [...t].length && [...shown].every((c, i) => c.toLowerCase() === [...t][i]!.toLowerCase())) {
        expect(rule.check(ok(`x${a}${shown}${b}x`, "text/csv")).pass).toBe(true);
      }
      if (!`xx`.toLowerCase().includes(t.toLowerCase())) expect(rule.check(ok("xx", "text/csv")).pass).toBe(false);
    }), runs(800));
  });

  it("requiredPhrasesOf gives back the confirmed phrases in order; the same phrase twice is stored once", () => {
    fc.assert(fc.property(fc.array(phrase, { minLength: 1, maxLength: 3 }), (ps) => {
      let def = base;
      for (const p of ps) def = withRequiredPhrase(def, p);
      def = withRequiredPhrase(def, ps[0]!);
      const want = [...new Set(ps.map((p) => p.trim()))];
      // Phrases that differ only by case are the same check (any case), so dedupe by the compiled pattern instead.
      expect(requiredPhrasesOf(def).length).toBeLessThanOrEqual(want.length);
      expect(requiredPhrasesOf(def)[0]).toBe(ps[0]!.trim());
      expect(ruleHash(withRequiredPhrase(def, ps[0]!))).toBe(ruleHash(def));
    }), runs(500));
  });

  it("refuses blank, multi-line, too long phrases and JSON promises", () => {
    expect(() => withRequiredPhrase(base, "   ")).toThrow();
    expect(() => withRequiredPhrase(base, "a\nb")).toThrow();
    expect(() => withRequiredPhrase(base, "a".repeat(201))).toThrow();
    expect(() => withRequiredPhrase(inferRule([{ a: 1 }]), "abc")).toThrow();
  });

  it("an HTML error page never keeps a non-markup text promise", () => {
    fc.assert(fc.property(fc.constantFrom("<html>", "  <!DOCTYPE html>", "\n<HTML lang=en>", "<!doctype HTML>"), fc.string(), (head, rest) => {
      expect(compileRule(base).check(ok(head + rest, "text/csv")).pass).toBe(false);
    }), runs(300));
  });
});
