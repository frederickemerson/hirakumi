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
  // "api.example.com." names the same host but is a different origin and listing base: one spelling only.
  if (u.hostname.endsWith(".")) throw new ValidationError("Remove the dot at the end of the host name in the link.");
  // The file only describes the API (ownership is a DNS record), so it may be hosted anywhere.
  // A query is still refused: the link is stored and shown on the seller's pages and Sokosumi task, a query often
  // carries an access token (the file must be public), and one plain link per file keeps resubmits the same API.
  if (u.search !== "" || s.split("#")[0].includes("?")) throw new ValidationError("Remove the ?query from the link. Use the plain public link to your OpenAPI file.");
  // A #fragment is never sent to the server, so it is dropped rather than refused.
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
