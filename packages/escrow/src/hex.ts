const HEX = /^(?:[0-9a-f]{2})*$/;

/** Lower-cases and checks `v` is even-length hex of exactly `bytes` bytes (any length when omitted). */
export function hexOf(name: string, v: string, bytes?: number): string {
  const h = typeof v === "string" ? v.toLowerCase() : "";
  if (!HEX.test(h)) throw new Error(`${name} must be hex`);
  if (bytes !== undefined && h.length !== bytes * 2) throw new Error(`${name} must be ${bytes} bytes`);
  return h;
}

export function bytesOf(name: string, v: string, bytes?: number): Uint8Array {
  return Uint8Array.from(Buffer.from(hexOf(name, v, bytes), "hex"));
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}
