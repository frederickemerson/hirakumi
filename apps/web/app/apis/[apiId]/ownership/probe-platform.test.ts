import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probePlatform } from "./probe-platform";

const CODE = "hkv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
let server: Server;
let origin: string;
const seen: { method?: string; url?: string; ua?: string }[] = [];

beforeAll(async () => {
  vi.stubEnv("ALLOW_INSECURE_UPSTREAM", "1");
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, ua: req.headers["user-agent"] });
    if (req.url === "/v1") {
      res.writeHead(404, { server: "nginx/1.25.3", "x-powered-by": "Express" });
      res.end("not found");
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((r) => server.close(r));
});

describe("probePlatform", () => {
  it("GETs the base URL once and reads the platform from its headers, on any status", async () => {
    seen.length = 0;
    expect(await probePlatform({ origin, pathPrefix: "/v1" }, CODE)).toEqual([
      { id: "express", evidence: "x-powered-by: Express" },
      { id: "nginx", evidence: "server: nginx/1.25.3" },
    ]);
    expect(seen).toEqual([{ method: "GET", url: "/v1", ua: "hirakumi-gateway/0.1" }]);
  });

  it("gives no hint, without throwing, when the server says nothing or can't be reached", async () => {
    expect(await probePlatform({ origin, pathPrefix: "/plain" }, CODE)).toEqual([]);
    expect(await probePlatform({ origin: "http://127.0.0.1:1", pathPrefix: "/" }, CODE)).toEqual([]);
  });

  it("never requests a URL the ownership check would refuse", async () => {
    seen.length = 0;
    expect(await probePlatform({ origin, pathPrefix: `/${CODE}` }, CODE)).toEqual([]);
    expect(await probePlatform({ origin, pathPrefix: "/a/../b" }, CODE)).toEqual([]);
    expect(seen).toEqual([]);
  });
});
