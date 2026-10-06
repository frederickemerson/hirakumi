import http from "node:http";

type Mode = "ok" | "empty" | "stale";
let mode: Mode = "ok";
const port = Number(process.env.STUB_PORT ?? 4030);

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && url.pathname === "/mode") {
    const m = url.searchParams.get("set");
    if (m === "ok" || m === "empty" || m === "stale") mode = m;
    res.end(`mode=${mode}\n`);
    return;
  }
  if (url.pathname === "/price") {
    const updatedAt = mode === "stale" ? new Date(Date.now() - 3_600_000) : new Date();
    const body = mode === "empty" ? {} : { symbol: url.searchParams.get("symbol") ?? "ADA", price: 0.42, updatedAt: updatedAt.toISOString() };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, "127.0.0.1", () => {
  console.log(`stub seller on http://127.0.0.1:${port}  (curl -X POST 'http://127.0.0.1:${port}/mode?set=empty')`);
});
