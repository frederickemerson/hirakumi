import { createServer, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

/** Answers the gateway's /internal/* routes the way the contract describes them. Dev and tests only. */
export function startMockGateway(port: number, token: string, opts: { challengeOk?: boolean } = {}): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
    const url = req.url ?? "";
    const check = url.match(/^\/internal\/challenge\/([^/]+)\/check$/);
    if (req.method === "POST" && check) {
      const ok = opts.challengeOk ?? process.env.MOCK_CHALLENGE !== "fail";
      const triedUrl = `https://price.example.dev/.well-known/hirakumi/${check[1]}.txt`;
      return send(res, 200, ok
        ? { ok: true, triedUrl, detail: "The file matched." }
        : { ok: false, triedUrl, detail: "Got HTTP 404 Not Found." });
    }
    if (req.method === "POST" && /^\/internal\/apis\/[^/]+\/reload$/.test(url)) return send(res, 204);
    if (req.method === "GET" && /^\/internal\/apis\/[^/]+\/health$/.test(url)) {
      return send(res, 200, { health: "healthy", checkedAt: new Date().toISOString(), lastReasons: [] });
    }
    return send(res, 404, { error: "not found" });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_GATEWAY_PORT ?? 4999);
  const token = process.env.INTERNAL_TOKEN ?? "change-me-32-bytes";
  startMockGateway(port, token).then(() => console.log(`mock gateway on http://127.0.0.1:${port}`));
}
