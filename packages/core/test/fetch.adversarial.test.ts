import { afterEach, describe, expect, it } from "vitest";
import { isBlockedAddress, safeFetch, UpstreamBlockedError } from "../src/fetch";

afterEach(() => { delete process.env.ALLOW_INSECURE_UPSTREAM; });

describe("adversarial: IP literal encodings stay blocked", () => {
  it.each([
    "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://127.1/", "https://0/",
    "https://[::]/", "https://[::ffff:127.0.0.1]/", "https://[0:0:0:0:0:ffff:7f00:1]/",
    "https://[64:ff9b::a9fe:a9fe]/", "https://[::127.0.0.1]/", "https://169.254.169.254./",
    "https://[::ffff:169.254.169.254]/", "https://[fd00:ec2::254]/", "https://[fe80::1]/",
  ])("%s is refused before connecting", async (url) => {
    await expect(safeFetch(url, { method: "GET" })).rejects.toBeInstanceOf(UpstreamBlockedError);
  });

  it.each(["file:///etc/passwd", "ftp://example.com/", "data:text/plain,hi", "http://example.com/"])(
    "non-https scheme %s is refused", async (url) => {
      await expect(safeFetch(url, { method: "GET" })).rejects.toBeInstanceOf(UpstreamBlockedError);
    });

  it("userinfo tricks are refused", async () => {
    await expect(safeFetch("https://good.example@127.0.0.1/", { method: "GET" })).rejects.toBeInstanceOf(UpstreamBlockedError);
  });

  it("the insecure dev flag only opens plain localhost, not look-alikes", async () => {
    process.env.ALLOW_INSECURE_UPSTREAM = "1";
    for (const url of ["http://127.0.0.2/", "http://[::1]/", "http://localhost.evil.example/"]) {
      await expect(safeFetch(url, { method: "GET" })).rejects.toBeInstanceOf(UpstreamBlockedError);
    }
  });

  it("isBlockedAddress treats non-IP input as blocked", () => {
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("localhost")).toBe(true);
  });
});

