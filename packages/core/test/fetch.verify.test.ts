// Independent verifier: IPv6 spellings that embed a private IPv4 address (finding L11 and neighbours).
import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "../src/fetch";

describe("verify: embedded-IPv4 IPv6 forms are blocked", () => {
  it.each([
    // SIIT ::ffff:0:0/96 in every spelling Node or a resolver may produce
    "::ffff:0:127.0.0.1", "::ffff:0:7f00:1", "0:0:0:0:ffff:0:7f00:1", "0::ffff:0:a9fe:a9fe", "::FFFF:0:A9FE:A9FE", "::ffff:0000:10.0.0.1",
    // IPv4-mapped
    "::ffff:7f00:1", "0:0:0:0:0:ffff:a9fe:a9fe", "::ffff:192.168.1.1",
    // NAT64 well-known and local-use prefixes
    "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b:1::a9fe:a9fe",
    // Teredo, 6to4, site-local, discard-only, ULA, link-local, multicast, unspecified, loopback
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001::1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "fec0::1", "feff::1", "100::1", "100::ffff:ffff:ffff:ffff",
    "fd12:3456::1", "fc00::1", "fe80::1", "ff02::1", "::", "::1", "0:0:0:0:0:0:0:1",
    // deprecated IPv4-compatible
    "::127.0.0.1", "::7f00:1", "::a9fe:a9fe",
  ])("%s is blocked", (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2a00:1450:4001:830::200e", "1.1.1.1", "8.8.8.8", "::ffff:8.8.8.8", "::ffff:0:8.8.8.8"])(
    "liveness: public %s is allowed", (addr) => {
      expect(isBlockedAddress(addr)).toBe(false);
    });
});
