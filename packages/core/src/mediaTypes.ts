/**
 * Media types Hirakumi can check. No Node imports, so client components can use it too
 * (import from "@hirakumi/core/media-types").
 */

/**
 * application/json, structured-syntax JSON such as application/vnd.api+json or application/problem+json, and JSON
 * sent as text (text/json, text/x-json, text/*+json): the body is parsed and checked as JSON.
 */
export function isJsonMediaType(ct: string): boolean {
  return ct === "application/json" || /^application\/[a-z0-9.!#$&^_-]+\+json$/.test(ct)
    || ct === "text/json" || ct === "text/x-json" || /^text\/[a-z0-9.!#$&^_-]+\+json$/.test(ct);
}

/** Answers Hirakumi can check as text: text/* (but not JSON sent as text), XML, CSV and YAML. Binary types are not. */
export function isTextMediaType(ct: string): boolean {
  if (isJsonMediaType(ct)) return false;
  return /^text\/[a-z0-9.+-]+$/.test(ct)
    || ct === "application/xml" || /^application\/[a-z0-9.!#$&^_-]+\+xml$/.test(ct)
    || ct === "application/csv" || ct === "application/yaml" || ct === "application/x-yaml";
}

/** Text types whose good answers are markup themselves, so an HTML page is not a sign of an error. */
export function isMarkupMediaType(ct: string): boolean {
  return ct === "text/html" || ct === "text/xml" || ct === "application/xml" || /\+xml$/.test(ct);
}

/** The media type of a Content-Type header, lowercased without parameters. */
export function mediaTypeOf(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}
