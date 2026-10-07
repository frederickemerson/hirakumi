import { describe, expect, it } from "vitest";
import { validateApiName, validateOpenApiUrl, ValidationError } from "./validate";

describe("validateOpenApiUrl", () => {
  it("accepts https links and derives the origin", () => {
    expect(validateOpenApiUrl(" https://price.example.dev/openapi.json ", false)).toEqual({
      url: "https://price.example.dev/openapi.json",
      origin: "https://price.example.dev",
      hostname: "price.example.dev",
    });
  });

  it.each([
    ["", "Paste the link to your OpenAPI description."],
    ["not a url", "That doesn't look like a web link. It should start with https://"],
    ["http://price.example.dev/openapi.json", "The link must start with https://"],
    ["https://user:pw@price.example.dev/openapi.json", "Remove the username and password from the link. Hirakumi only supports public API descriptions."],
    // a query often carries an access token, and the link is stored and shown
    ["https://victim.example/proxy?u=https://evil.example/openapi.json", "Remove the ?query from the link."],
    ["https://price.example.dev/openapi.json?v=2", "Remove the ?query from the link."],
    ["https://price.example.dev/openapi.json?", "Remove the ?query from the link."],
    ["https://price.example.dev./openapi.json", "Remove the dot at the end of the host name in the link."],
    ["https://price.example.dev.:8443/openapi.json", "Remove the dot at the end of the host name in the link."],
  ])("rejects %j", (input, message) => {
    expect(() => validateOpenApiUrl(input, false)).toThrow(ValidationError);
    expect(() => validateOpenApiUrl(input, false)).toThrow(message);
  });

  it("accepts a file hosted anywhere, and drops a #fragment", () => {
    expect(validateOpenApiUrl("https://raw.githubusercontent.com/acme/prices/main/openapi.yaml#top", false)).toEqual({
      url: "https://raw.githubusercontent.com/acme/prices/main/openapi.yaml",
      origin: "https://raw.githubusercontent.com",
      hostname: "raw.githubusercontent.com",
    });
  });

  it("allows http://localhost only when insecure upstreams are allowed", () => {
    expect(() => validateOpenApiUrl("http://localhost:4000/openapi.json", false)).toThrow("The link must start with https://");
    expect(validateOpenApiUrl("http://localhost:4000/openapi.json", true).origin).toBe("http://localhost:4000");
  });
});

describe("validateApiName", () => {
  it("falls back to the hostname and limits length", () => {
    expect(validateApiName(undefined, "price.example.dev")).toBe("price.example.dev");
    expect(validateApiName("  Price API ", "x")).toBe("Price API");
    expect(() => validateApiName("x".repeat(81), "x")).toThrow("Keep the name under 80 characters.");
  });
});
