import { describe, expect, it } from "vitest";
import { apiBase } from "../src/onboarding/parseStep.js";
import { likelySpecLink } from "../src/sokosumi/replies.js";

// One list of file hosts: a host that serves files is never where the API runs, wherever the check happens.
describe("file hosts", () => {
  it("refuses a relative servers URL on any file host, pastebin included", () => {
    for (const ref of ["https://pastebin.com/raw/abc", "https://cdn.jsdelivr.net/gh/acme/api/openapi.json"]) {
      expect(() => apiBase("/v1", ref)).toThrow(/can't be where your API runs/);
    }
  });
  it("reads a link on any file host as a spec link, jsDelivr included", () => {
    expect(likelySpecLink("https://cdn.jsdelivr.net/gh/acme/api/spec-file")).toBe(true);
    expect(likelySpecLink("https://pastebin.com/raw/abc")).toBe(true);
  });
});
