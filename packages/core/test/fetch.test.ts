import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodeBody, isBlockedAddress, safeFetch, UpstreamBlockedError, UpstreamTimeoutError, UpstreamTooLargeError,
} from "../src/fetch";

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ok") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://169.254.169.254/" }); res.end(); return; }
    if (req.url === "/big") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ pad: "x".repeat(5000) })); return; }
    if (req.url === "/slow") { setTimeout(() => { res.writeHead(200); res.end("{}"); }, 1000); return; }
    if (req.url === "/bom.csv") { res.writeHead(200, { "content-type": "text/csv" }); res.end(Buffer.from("\uFEFFsym,price\nADA,0.35\n")); return; }
    if (req.url === "/latin1.csv") { res.writeHead(200, { "content-type": "text/csv; charset=ISO-8859-1" }); res.end(Buffer.from("café,1\n", "latin1")); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { delete process.env.ALLOW_INSECURE_UPSTREAM; });

describe("isBlockedAddress", () => {
  it.each([
    ["10.1.2.3", true], ["172.20.0.1", true], ["192.168.1.1", true], ["127.0.0.1", true],
    ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true], ["::1", true],
    ["fd00:ec2::254", true], ["fe80::1", true], ["::ffff:127.0.0.1", true], ["not-an-ip", true],
    ["::ffff:7f00:1", true], ["::ffff:a9fe:a9fe", true],
    ["2002:7f00:1::1", true], ["64:ff9b:1::a00:1", true], ["::7f00:1", true], ["::a9fe:a9fe", true],
    ["8.8.8.8", false], ["2606:4700:4700::1111", false], ["::ffff:808:808", false],
    // SIIT IPv4-translated (::ffff:0:0/96) is judged by the embedded IPv4; fec0::/10, 100::/64, 2001::/32 are blocked.
    ["::ffff:0:7f00:1", true], ["::ffff:0:127.0.0.1", true], ["0:0:0:0:ffff:0:a9fe:a9fe", true],
    ["0000:0000:0000:0000:ffff:0000:10.0.0.1", true], ["::ffff:0:808:808", false],
    ["fec0::1", true], ["100::1", true], ["2001::1", true], ["2001:0:4136:e378::1", true],
    ["2001:4860:4860::8888", false],
  ])("%s → %s", (addr, blocked) => { expect(isBlockedAddress(addr)).toBe(blocked); });
});

describe("safeFetch blocks", () => {
  it.each([
    ["plain http to a public host", "http://example.com/"],
    ["http localhost without the flag", "http://127.0.0.1:1/"],
    ["https loopback literal", "https://127.0.0.1/"],
    ["https metadata literal", "https://169.254.169.254/latest/meta-data"],
    ["https ipv6 loopback literal", "https://[::1]/"],
    ["https hostname resolving to loopback (DNS check)", "https://localhost:1/"],
    ["credentials in the URL", "https://user:pw@example.com/"],
  ])("%s", async (_name, url) => {
    await expect(safeFetch(url, { method: "GET" })).rejects.toBeInstanceOf(UpstreamBlockedError);
  });
  it("refusing redirects and oversize bodies leaves no unhandled stream error", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    const errors: unknown[] = [];
    const onErr = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onErr);
    try {
      for (let i = 0; i < 20; i++) {
        await expect(safeFetch(`${base}/redirect`, { method: "GET" })).rejects.toBeInstanceOf(UpstreamBlockedError);
        await expect(safeFetch(`${base}/big`, { method: "GET" }, { maxBytes: 1000 })).rejects.toBeInstanceOf(UpstreamTooLargeError);
      }
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("uncaughtException", onErr);
    }
    expect(errors).toEqual([]);
  });
  it("redirects are refused, not followed", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    await expect(safeFetch(`${base}/redirect`, { method: "GET" })).rejects.toBeInstanceOf(UpstreamBlockedError);
    await expect(safeFetch(`${base}/redirect`, { method: "GET" })).rejects.toMatchObject({
      name: "UpstreamRedirectError", status: 302, location: "http://169.254.169.254/",
    });
  });
});

describe("safeFetch with ALLOW_INSECURE_UPSTREAM=1 (local stubs)", () => {
  it("returns status, content type, body and latency", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    const r = await safeFetch(`${base}/ok`, { method: "GET" });
    expect(r).toMatchObject({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
  it("caps the response size", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    await expect(safeFetch(`${base}/big`, { method: "GET" }, { maxBytes: 1000 })).rejects.toBeInstanceOf(UpstreamTooLargeError);
  });
  it("caps the request size at 256 KB", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    await expect(safeFetch(`${base}/ok`, { method: "POST", body: "x".repeat(262_145) })).rejects.toBeInstanceOf(UpstreamTooLargeError);
  });
  it("times out", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    await expect(safeFetch(`${base}/slow`, { method: "GET" }, { timeoutMs: 100 })).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });
});

describe("decodeBody", () => {
  const utf16be = (t: string) => Buffer.from(t, "utf16le").swap16();
  it("drops a leading BOM, as WHATWG res.text() does", async () => {
    const bytes = Buffer.from("\uFEFFsym,price\n");
    expect(decodeBody(bytes, "text/csv")).toBe("sym,price\n");
    expect(decodeBody(bytes, "text/csv")).toBe(await new Response(bytes).text());
    expect(decodeBody(Buffer.from('\uFEFF{"a":1}'), "application/json")).toBe('{"a":1}');
    // The gateway re-sends the body as UTF-8, where a U+FEFF left at the start would be a BOM the buyer drops again.
    expect(decodeBody(Buffer.from("\uFEFF\uFEFFx"), "text/plain")).toBe("x");
  });
  it("uses the declared charset when TextDecoder knows it, else UTF-8", () => {
    expect(decodeBody(Buffer.from("café", "latin1"), "text/csv; charset=iso-8859-1")).toBe("café");
    expect(decodeBody(Buffer.from("café", "latin1"), 'text/plain; charset="latin1"')).toBe("café");
    expect(decodeBody(Buffer.from([0x80]), "text/plain; charset=windows-1252")).toBe("€");
    expect(decodeBody(Buffer.from("café", "utf16le"), "text/plain; charset=UTF-16LE")).toBe("café");
    expect(decodeBody(utf16be("café"), "text/plain; charset=utf-16be")).toBe("café");
    expect(decodeBody(Buffer.from("café"), "text/plain; charset=x-made-up")).toBe("café");
    expect(decodeBody(Buffer.from("café"), "text/plain")).toBe("café");
    expect(decodeBody(Buffer.from("café"), null)).toBe("café");
  });
  it("a UTF-16 BOM wins over the label", () => {
    expect(decodeBody(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b", "utf16le")]), "text/csv")).toBe("a,b");
    expect(decodeBody(Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be("a,b")]), "text/csv; charset=utf-8")).toBe("a,b");
  });
  it("JSON is UTF-8 whatever its label says (RFC 8259), so answers that pass today don't change", () => {
    expect(decodeBody(Buffer.from('{"name":"café"}'), "application/json; charset=iso-8859-1")).toBe('{"name":"café"}');
  });
});

describe("safeFetch decodes text", () => {
  it("drops a BOM and honours a declared charset", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    expect((await safeFetch(`${base}/bom.csv`, { method: "GET" })).body).toBe("sym,price\nADA,0.35\n");
    expect((await safeFetch(`${base}/latin1.csv`, { method: "GET" })).body).toBe("café,1\n");
  });
});
