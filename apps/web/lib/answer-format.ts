/*
 * Answers are JSON or text (CSV, XML, plain text...). A promise's definition names the media type every good
 * answer has (@hirakumi/core rules.ts). These mirror its helpers without importing @hirakumi/core, which pulls in
 * node:crypto and must stay out of client components.
 */

/** The media type of a Content-Type header, lowercased without parameters. */
export function mediaTypeOf(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** application/json and any +json type. */
export function isJsonMediaType(ct: string): boolean {
  return ct === "application/json" || /^application\/[a-z0-9.!#$&^_-]+\+json$/.test(ct);
}

/** The media type a promise checks (rules.definition.contentType). Rules from before text answers are JSON. */
export function promiseMediaType(definition: unknown): string {
  const ct = (definition as { contentType?: unknown } | null)?.contentType;
  return typeof ct === "string" && ct ? mediaTypeOf(ct) : "application/json";
}

export const isTextPromise = (definition: unknown) => !isJsonMediaType(promiseMediaType(definition));

/** A short name for an answer format, for sellers and buyers: "JSON", "CSV", "XML", "plain text" or the type. */
export function answerFormatLabel(ct: string): string {
  const t = mediaTypeOf(ct);
  if (isJsonMediaType(t)) return "JSON";
  if (t === "text/csv" || t === "application/csv") return "CSV";
  if (t === "text/xml" || t === "application/xml" || t.endsWith("+xml")) return "XML";
  if (t === "text/plain") return "plain text";
  if (t === "text/html") return "HTML";
  if (t === "text/yaml" || t === "application/yaml" || t === "application/x-yaml") return "YAML";
  return t || "text";
}

/** One line under a text promise: "Answers are CSV (text/csv), checked as text." Null for a JSON promise. */
export function promiseFormatNote(definition: unknown): string | null {
  const ct = promiseMediaType(definition);
  return isJsonMediaType(ct) ? null : `Answers are ${answerFormatLabel(ct)} (${ct}), checked as text.`;
}
