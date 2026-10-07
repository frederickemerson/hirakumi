import { describe, expect, it } from "vitest";
import { detectPlatforms } from "./header-platform";

const ids = (h: Record<string, string | string[]>) => detectPlatforms(h).map((x) => x.id);

describe("detectPlatforms", () => {
  it.each([
    [{ "x-powered-by": "Express" }, "express", "x-powered-by: Express"],
    [{ "x-powered-by": "Next.js" }, "nextjs", "x-powered-by: Next.js"],
    [{ "x-nextjs-cache": "HIT" }, "nextjs", "x-nextjs-cache: HIT"],
    [{ server: "uvicorn" }, "fastapi", "server: uvicorn"],
    [{ server: "Werkzeug/3.0.1 Python/3.12.2" }, "flask", "server: Werkzeug/3.0.1 Python/3.12.2"],
    [{ "x-vercel-id": "sin1::abc" }, "vercel", "x-vercel-id: sin1::abc"],
    [{ server: "Vercel" }, "vercel", "server: Vercel"],
    [{ "x-nf-request-id": "01J9" }, "netlify", "x-nf-request-id: 01J9"],
    [{ server: "Netlify" }, "netlify", "server: Netlify"],
    [{ "cf-ray": "8f1d2c3b4a-SIN" }, "cloudflare", "cf-ray: 8f1d2c3b4a-SIN"],
    [{ server: "cloudflare" }, "cloudflare", "server: cloudflare"],
    [{ server: "nginx/1.25.3" }, "nginx", "server: nginx/1.25.3"],
    [{ server: "openresty" }, "nginx", "server: openresty"],
  ])("%j is %s", (headers, id, evidence) => {
    expect(detectPlatforms(headers)).toEqual([{ id, evidence }]);
  });

  it("puts the app's framework before the host and the web server in front of it", () => {
    expect(ids({ server: "nginx", "x-powered-by": "Express" })).toEqual(["express", "nginx"]);
    expect(ids({ "x-vercel-id": "x", "x-powered-by": "Next.js" })).toEqual(["nextjs", "vercel"]);
    expect(ids({ server: "cloudflare", "cf-ray": "1", "x-powered-by": "Express" })).toEqual(["express", "cloudflare"]);
  });

  it("knows nothing from headers that don't name a platform", () => {
    expect(detectPlatforms({})).toEqual([]);
    expect(detectPlatforms({ server: "gunicorn", "content-type": "application/json" })).toEqual([]);
    expect(detectPlatforms({ server: "Apache/2.4", "x-powered-by": "PHP/8.3" })).toEqual([]);
    // A word inside another value is not the platform.
    expect(detectPlatforms({ server: "my-nginx-clone" })).toEqual([]);
  });

  it("reads the first of a repeated header, any name case, and shortens long values", () => {
    expect(detectPlatforms({ Server: ["nginx", "cloudflare"] })).toEqual([{ id: "nginx", evidence: "server: nginx" }]);
    const long = detectPlatforms({ "cf-ray": "x".repeat(200) })[0].evidence;
    expect(long.length).toBe(60);
    expect(long.endsWith("…")).toBe(true);
  });
});
