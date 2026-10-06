import http from "node:http";
import type { AddressInfo } from "node:net";

export type RecordedRequest = { method: string; url: string; headers: http.IncomingHttpHeaders; body: unknown };
export type FakeRoute = (req: RecordedRequest) => { status: number; body: unknown } | undefined;
export type FakeServer = { url: string; calls: RecordedRequest[]; close(): Promise<void> };

/** A real HTTP server on 127.0.0.1 that records requests and answers from `route` (404 when it returns undefined). */
export async function startFakeServer(route: FakeRoute): Promise<FakeServer> {
  const calls: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const rec: RecordedRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      calls.push(rec);
      const out = route(rec) ?? { status: 404, body: { error: "NotFound", message: "no route" } };
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
