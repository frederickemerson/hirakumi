import { isJsonMediaType as coreIsJson, mediaTypeOf as coreMediaTypeOf } from "@hirakumi/core";
import { describe, expect, it } from "vitest";
import { answerFormatLabel, isJsonMediaType, isTextPromise, mediaTypeOf, promiseFormatNote, promiseMediaType } from "./answer-format";

describe("answer formats", () => {
  it("agrees with @hirakumi/core on media types", () => {
    for (const ct of ["application/json", "application/vnd.api+json", "application/problem+json", "text/csv", "text/plain", "application/xml", "", "TEXT/CSV; charset=utf-8"]) {
      expect(mediaTypeOf(ct)).toBe(coreMediaTypeOf(ct));
      expect(isJsonMediaType(mediaTypeOf(ct))).toBe(coreIsJson(coreMediaTypeOf(ct)));
    }
  });

  it("treats a promise without a content type, or a JSON one, as JSON", () => {
    expect(promiseMediaType({})).toBe("application/json");
    expect(promiseMediaType(null)).toBe("application/json");
    expect(isTextPromise({ contentType: "application/json" })).toBe(false);
    expect(isTextPromise({ contentType: "application/vnd.api+json" })).toBe(false);
    expect(promiseFormatNote({ contentType: "application/json" })).toBeNull();
  });

  it("names text formats plainly", () => {
    expect(isTextPromise({ contentType: "text/csv" })).toBe(true);
    expect(promiseFormatNote({ contentType: "text/csv" })).toBe("Answers are CSV (text/csv), checked as text.");
    expect(answerFormatLabel("application/atom+xml")).toBe("XML");
    expect(answerFormatLabel("text/plain; charset=utf-8")).toBe("plain text");
    expect(answerFormatLabel("text/markdown")).toBe("text/markdown");
  });
});
