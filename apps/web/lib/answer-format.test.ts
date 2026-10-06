import * as core from "@hirakumi/core";
import * as mediaTypes from "@hirakumi/core/media-types";
import { describe, expect, it } from "vitest";
import { answerFormatLabel, isJsonMediaType, isTextPromise, mediaTypeOf, promiseFormatNote, promiseMediaType } from "./answer-format";

describe("answer formats", () => {
  it("uses the media type helpers of @hirakumi/core, not a copy", () => {
    expect(isJsonMediaType).toBe(mediaTypes.isJsonMediaType);
    expect(mediaTypeOf).toBe(mediaTypes.mediaTypeOf);
    expect(core.isJsonMediaType).toBe(mediaTypes.isJsonMediaType);
  });

  it("treats a promise without a content type, or a JSON one, as JSON", () => {
    expect(promiseMediaType({})).toBe("application/json");
    expect(promiseMediaType(null)).toBe("application/json");
    expect(isTextPromise({ contentType: "application/json" })).toBe(false);
    expect(isTextPromise({ contentType: "application/vnd.api+json" })).toBe(false);
    expect(isTextPromise({ contentType: "text/json" })).toBe(false);
    expect(promiseFormatNote({ contentType: "application/json" })).toBeNull();
  });

  it("names text formats plainly", () => {
    expect(isTextPromise({ contentType: "text/csv" })).toBe(true);
    expect(promiseFormatNote({ contentType: "text/csv" })).toBe("Answers are CSV (text/csv), checked as text.");
    expect(answerFormatLabel("application/atom+xml")).toBe("XML");
    expect(answerFormatLabel("text/json")).toBe("JSON");
    expect(answerFormatLabel("text/plain; charset=utf-8")).toBe("plain text");
    expect(answerFormatLabel("text/markdown")).toBe("text/markdown");
  });
});
