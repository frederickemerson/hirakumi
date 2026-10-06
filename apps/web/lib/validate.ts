export class ValidationError extends Error {}

export function validateOpenApiUrl(raw: unknown, allowInsecure: boolean): { url: string; origin: string; hostname: string } {
  if (typeof raw !== "string" || raw.trim() === "") throw new ValidationError("Paste the link to your OpenAPI description.");
  const s = raw.trim();
  if (s.length > 2048) throw new ValidationError("That link is too long.");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ValidationError("That doesn't look like a web link. It should start with https://");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(allowInsecure && u.protocol === "http:" && local)) {
    throw new ValidationError("The link must start with https://");
  }
  if (u.username || u.password) {
    throw new ValidationError("Remove the username and password from the link. Hirakumi only supports public API descriptions.");
  }
  // The proof is scoped to the folder the file is served from, so the link must be a plain file path:
  // a query (a proxy such as /fetch?u=...) or a route that serves any content would prove the whole host.
  if (u.search !== "") throw new ValidationError("Remove the ?query from the link. Use the plain path to your OpenAPI file.");
  if (u.hash !== "") throw new ValidationError("Remove the #fragment from the link. Use the plain path to your OpenAPI file.");
  u.search = "";
  u.hash = "";
  return { url: u.toString(), origin: u.origin, hostname: u.hostname };
}

export function validateApiName(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return fallback.slice(0, 80);
  if (typeof raw !== "string") throw new ValidationError("The name must be text.");
  const s = raw.trim();
  if (s.length > 80) throw new ValidationError("Keep the name under 80 characters.");
  return s;
}
