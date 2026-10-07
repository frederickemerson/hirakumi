// Local seller for the live stress run. GET <base>/price answers the price promise (or breaks it on command);
// any other path is the API's base URL and carries X-Hirakumi-Verify when a code is set. POST /__admin
// {"mode": "ok"|"empty"|"stale"|"flip"|"slow"|"error", "verify": "<code>"|null} changes behaviour.
import http from "node:http";

const port = Number(process.env.SELLER_PORT ?? 4910);
let mode = "ok";
let verify = null;
let n = 0;
const counts = { price: 0, base: 0 };
const ok = (symbol) => JSON.stringify({ symbol, price: 0.42, updatedAt: new Date().toISOString() });
http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://seller");
  if (u.pathname === "/__admin" && req.method === "POST") {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      const o = JSON.parse(b || "{}");
      if (o.mode) mode = o.mode;
      if ("verify" in o) verify = o.verify;
      res.end(JSON.stringify({ mode, verify, counts }));
    });
    return;
  }
  if (u.pathname.endsWith("/price")) {
    counts.price++;
    const symbol = u.searchParams.get("symbol") ?? "ADA";
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body); };
    switch (mode) {
      case "ok": return send(200, ok(symbol));
      case "empty": return send(200, "{}");
      case "stale": return send(200, JSON.stringify({ symbol, price: 0.42, updatedAt: new Date(Date.now() - 3_600_000).toISOString() }));
      case "flip": return (n++ % 2) ? send(200, ok(symbol)) : send(200, "{}");
      case "error": return send(500, '{"error":"boom"}');
      case "slow": return setTimeout(() => send(200, ok(symbol)), 200);
    }
  }
  counts.base++;
  res.writeHead(200, verify ? { "x-hirakumi-verify": verify, "content-type": "text/plain" } : { "content-type": "text/plain" });
  res.end("hi");
}).listen(port, "127.0.0.1", () => console.log(`[seller] on 127.0.0.1:${port}`));
