// The gateway's HTTP server. x402 v2 sends the whole signed Cardano transaction in PAYMENT-SIGNATURE: an escrow
// lock with its inline datum is about 16 KB, past Node's 16 KB default for all headers once Caddy adds its own.
import { createServer, type Server } from "node:http";
import type { Express, RequestHandler } from "express";

export const MAX_HEADER_BYTES = 64 * 1024;
/** The larger header limit must not admit huge URLs: no route needs more than this. */
export const MAX_URL_BYTES = 8 * 1024;

export const limitUrl: RequestHandler = (req, res, next) => {
  if (req.originalUrl.length > MAX_URL_BYTES) { res.status(414).json({ error: "uri_too_long" }); return; }
  next();
};

export function listen(app: Express, port: number, onListening: () => void): Server {
  return createServer({ maxHeaderSize: MAX_HEADER_BYTES }, app).listen(port, onListening);
}
