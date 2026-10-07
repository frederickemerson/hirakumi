import { describe, expect, it } from "vitest";
import {
  ACT_PLACEHOLDER_RE, ACT_PLACEHOLDER_TEXT, actPath, actPlaceholder, hashActToken, isActAction, isActTokenShape, newActToken,
} from "../src/act";

describe("one-time action links", () => {
  it("makes 256-bit URL-safe tokens, stored only as their SHA-256", () => {
    const a = newActToken();
    expect(isActTokenShape(a)).toBe(true);
    expect(a).not.toBe(newActToken());
    expect(hashActToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashActToken(a)).not.toContain(a);
    expect(actPath(a)).toBe(`/act/${a}`);
    for (const bad of ["", "short", `${a}x`, `${a.slice(0, 42)}!`, null, 42]) expect(isActTokenShape(bad)).toBe(false);
  });

  it("knows exactly three actions", () => {
    expect(["ownership", "key", "publish"].every(isActAction)).toBe(true);
    expect(isActAction("retire")).toBe(false);
  });

  it("placeholders name the action and are replaced everywhere", () => {
    const body = `Sign: ${actPlaceholder("ownership")} or ${actPlaceholder("key")}`;
    expect([...body.matchAll(ACT_PLACEHOLDER_RE)].map((m) => m[1])).toEqual(["ownership", "key"]);
    expect(body.replace(ACT_PLACEHOLDER_RE, ACT_PLACEHOLDER_TEXT)).not.toContain("[[");
    expect("[[act:retire]]".replace(ACT_PLACEHOLDER_RE, "x")).toBe("[[act:retire]]");
  });
});
