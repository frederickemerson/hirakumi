// Stand-in for the gateway's MIP-003 /availability so the Masumi registry health
// check can be registered and timed before apps/gateway exists.
//   docker compose exec availability-stub touch /flags/down   -> 503
//   docker compose exec availability-stub rm -f /flags/down   -> 200
// Every request is logged with a timestamp, so the registry's check interval is
// the gap between consecutive registry hits in `docker compose logs availability-stub`.
import { createServer } from "node:http";
import { existsSync } from "node:fs";

const DOWN_FLAG = "/flags/down";
const PORT = 8080;

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://stub").pathname;
  const down = existsSync(DOWN_FLAG);
  const status = path !== "/availability" ? 404 : down ? 503 : 200;
  const from = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "-";
  console.log(`${new Date().toISOString()} ${req.method} ${path} from=${from} ua=${req.headers["user-agent"] ?? "-"} -> ${status}`);
  res.writeHead(status, { "content-type": "application/json" });
  if (status === 404) {
    res.end(JSON.stringify({ error: "not_found" }));
  } else if (status === 503) {
    res.end(JSON.stringify({ status: "unavailable", message: "spike stub is down", estimated_downtime_seconds: 60 }));
  } else {
    res.end(JSON.stringify({ status: "available", type: "masumi-agent", message: "spike stub is up" }));
  }
}).listen(PORT, "0.0.0.0", () => console.log(`availability stub listening on :${PORT}`));
