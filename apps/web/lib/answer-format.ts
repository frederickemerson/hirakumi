/*
 * Answers are JSON or text (CSV, XML, plain text...). A promise's definition names the media type every good
 * answer has (@hirakumi/core rules.ts). The media type helpers come from "@hirakumi/core/media-types", which has no
 * Node imports, so client components can use them.
 */
import { isJsonMediaType, mediaTypeOf } from "@hirakumi/core/media-types";

export { isJsonMediaType, isMarkupMediaType, isTextMediaType, mediaTypeOf } from "@hirakumi/core/media-types";

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

/**
 * Why a text promise needs a phrase every good answer contains (or a pinned header) before publishing: a promise
 * that only checks the status would let an error page sent with status 200 count as a good answer.
 */
export const WHY_PHRASE = "Without a phrase, an error page sent with status 200 could count as a good answer.";

/** The 409 publishing returns while any text promise only checks the status, naming those endpoints. Null if none. */
export function statusOnlyRefusal(promises: { method: string; path: string; statusOnly: boolean }[]): string | null {
  const open = promises.filter((p) => p.statusOnly).map((p) => `${p.method.toUpperCase()} ${p.path}`);
  if (open.length === 0) return null;
  return `Add a phrase every good answer contains for ${open.join(", ")} before publishing. ${WHY_PHRASE}`;
}
