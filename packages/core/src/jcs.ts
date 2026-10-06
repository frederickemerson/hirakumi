/**
 * RFC 8785 JSON Canonicalization Scheme. ES number and string serialisation (JSON.stringify)
 * is exactly what RFC 8785 specifies; keys are sorted by UTF-16 code units (default sort).
 */
export function jcs(value: unknown): string {
  let v = value;
  if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") {
    v = (v as { toJSON(): unknown }).toJSON();
  }
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new TypeError("JCS: non-finite number");
      return JSON.stringify(v);
    case "string":
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) {
        return `[${v.map((x) => (x === undefined || typeof x === "function" || typeof x === "symbol" ? "null" : jcs(x))).join(",")}]`;
      }
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined && typeof o[k] !== "function" && typeof o[k] !== "symbol")
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`JCS: cannot serialise ${typeof v}`);
  }
}
