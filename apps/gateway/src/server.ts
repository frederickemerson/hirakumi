// The gateway's HTTP server. x402 v2 sends the whole signed Cardano transaction in PAYMENT-SIGNATURE: an escrow
// lock with its inline datum is about 16 KB, past Node's 16 KB default for all headers once Caddy adds its own.
import { createServer, type Server } from "node:http";
import type { Express, RequestHandler } from "express";

const MAX_HEADER_BYTES = 64 * 1024;
/** The larger header limit must not admit huge URLs: no route needs more than this. */
export const MAX_URL_BYTES = 8 * 1024;

export const limitUrl: RequestHandler = (req, res, next) => {
  if (req.originalUrl.length > MAX_URL_BYTES) { res.status(414).json({ error: "uri_too_long" }); return; }
  // Postgres text can't hold U+0000, so an id or query value carrying one fails in the database (a 500). The HTTP
  // parser refuses a raw NUL, so in a URL it can only arrive as %00; a double-encoded %2500 decodes to the text "%00".
  if (/%00/.test(req.originalUrl)) { res.status(400).json({ error: "invalid_url", message: "The URL contains a NUL character (%00)." }); return; }
  next();
};

export function listen(app: Express, port: number, onListening: () => void): Server {
  return createServer({ maxHeaderSize: MAX_HEADER_BYTES }, app).listen(port, onListening);
}
