/**
 * The caller's address for rate limits. On Vercel, x-real-ip is set by the platform and a client can't choose
 * it; the left-most x-forwarded-for is only a fallback (a client may prepend its own entries there).
 */
export function clientAddress(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}
