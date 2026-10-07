import { AMBIGUOUS_PATH, unsafePathReason } from "./ownership";
import { isUnambiguousKeyParamName, looksLikeSecret, paramHoldsSecret } from "./secrets";

/**
 * Any API, no OpenAPI file: the seller gives a base URL and one example request per line. Hirakumi builds an
 * OpenAPI 3.1 document from them, so the rest of onboarding (parse, describe, QA, gateway) is unchanged.
 *
 * Line format: `[METHOD] /path/{name=value}?query=value&optional?=value [JSON body]`
 *   GET /price?symbol=ADA
 *   GET /coins/{id=bitcoin}?vs=usd&days?=7
 *   POST /search {"q": "ada", "limit": 5}
 * The method defaults to GET. `{name=value}` marks a path parameter and its example. A query name ending in
 * `?` is optional. Every value is also the example Hirakumi uses for its test calls. The same path may appear
 * on several lines to give more examples.
 *
 * The API's key never goes in a line: every value becomes a public input example for buyers, and the lines are
 * stored as they are. A line with a credential parameter (api_key=…, access_token=…), a key-shaped value under any
 * name (?k=7f3a9c1e…) or a key elsewhere in it is refused, and
 * the seller adds the key on the ownership page instead, sealed so only the gateway can read it.
 *
 * Ownership is proven like any other API: the X-Hirakumi-Verify response header at the base URL (ownership.ts).
 */
export const MAX_SAMPLE_LINES = 20;

export type SampleMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type SampleParam = { name: string; value: string; required: boolean };
export type Sample = {
  method: SampleMethod;
  /** Path template with `{name}` placeholders, relative to the base. */
  path: string;
  pathParams: SampleParam[];
  query: SampleParam[];
  body?: unknown;
};

export class SampleError extends Error {}

const KEY_ADVICE = "Remove it from the example requests. After you prove ownership, add the key on the ownership page, where only the Hirakumi gateway can read it.";

const METHODS = new Set<SampleMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** The base URL as a folder: https only (http on localhost when allowed), no credentials, query or fragment. */
export function normalizeSamplesBase(raw: unknown, allowInsecure = false): { base: string; origin: string; hostname: string } {
  if (typeof raw !== "string" || raw.trim() === "") throw new SampleError("Paste your API's base URL, for example https://api.example.com/v1");
  const s = raw.trim();
  if (s.length > 2048) throw new SampleError("That base URL is too long.");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new SampleError("The base URL doesn't look like a web link. It should start with https://");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(allowInsecure && u.protocol === "http:" && local)) throw new SampleError("The base URL must start with https://");
  if (u.username || u.password) throw new SampleError("Remove the username and password from the base URL.");
  if (u.search !== "" || /\?/.test(s)) throw new SampleError("Remove the ?query from the base URL. Put query parameters in the example requests.");
  if (u.hash !== "" || /#/.test(s)) throw new SampleError("Remove the #fragment from the base URL.");
  // The ownership check calls this exact host, and a trailing dot would make it a second name for the same API.
  if (u.hostname.endsWith(".")) throw new SampleError("Remove the dot at the end of the host name in the base URL.");
  if (AMBIGUOUS_PATH.test(u.pathname) || u.pathname.includes("\\")) throw new SampleError("The base URL has an encoded slash, dot or percent sign, a ';', a space or a character outside plain ASCII in its path. Use a plain path.");
  // An empty segment is a path some servers read as another folder, so the base would not name one folder.
  if (u.pathname.includes("//")) throw new SampleError("The base URL has two slashes in a row in its path. Use a plain path.");
  const dir = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  const base = `${u.origin}${dir === "/" ? "" : dir.slice(0, -1)}`;
  return { base, origin: u.origin, hostname: u.hostname };
}

function parseLine(line: string, n: number): Sample {
  const fail = (msg: string): never => {
    throw new SampleError(`Line ${n}: ${msg}`);
  };
  const decode = (s: string, what: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return fail(`${what} has a broken % escape. Write the character itself, or a full escape such as %20.`);
    }
  };
  // A credential name with any value of 8 characters or more (a placeholder too: the parameter itself is the key's),
  // or a value that holds a key under its name. key=BTC, appid=12 and use_auth=true are ordinary inputs.
  const keyParam = (name: string, value: string) => {
    if ((isUnambiguousKeyParamName(name) && value.length >= 8) || paramHoldsSecret(name, value)) {
      fail(`"${name}" looks like your API's key. ${KEY_ADVICE}`);
    }
  };
  let rest = line.trim();
  let method: SampleMethod = "GET";
  const m = /^([A-Za-z]+)\s+/.exec(rest);
  if (m) {
    const word = m[1].toUpperCase() as SampleMethod;
    if (!METHODS.has(word)) fail(`"${m[1]}" is not a method Hirakumi supports (GET, POST, PUT, PATCH or DELETE).`);
    method = word;
    rest = rest.slice(m[0].length).trim();
  }
  const space = rest.search(/\s/);
  const target = space === -1 ? rest : rest.slice(0, space);
  const bodyText = space === -1 ? "" : rest.slice(space).trim();
  if (!target.startsWith("/")) fail(`the path must start with "/", for example GET /price?symbol=ADA`);
  if (target.includes("#")) fail(`remove the #fragment.`);

  const q = target.indexOf("?");
  const rawPath = q === -1 ? target : target.slice(0, q);
  const rawQuery = q === -1 ? "" : target.slice(q + 1);

  const pathParams: SampleParam[] = [];
  const path = rawPath.replace(/\{([^}=]*)(?:=([^}]*))?\}/g, (_w, name: string, value: string | undefined) => {
    if (!NAME.test(name)) fail(`"{${name}}" is not a valid parameter name.`);
    if (value === undefined || value === "") fail(`give an example value for {${name}}, like {${name}=example}.`);
    if (pathParams.some((p) => p.name === name)) fail(`{${name}} appears twice in the path.`);
    const decoded = decode(value!, `the value of {${name}}`);
    keyParam(name, decoded);
    // The gateway refuses such a path value at call time, so the test calls would fail with no reason given.
    if (/[/\\]/.test(decoded) || decoded === "." || decoded === "..") {
      fail(`the value of {${name}} can't contain / or \\ or be . or .. because a path value is one part of the path. Put it in the query instead, like ?${name}=value.`);
    }
    pathParams.push({ name, value: decoded, required: true });
    return `{${name}}`;
  });
  if (/[{}]/.test(path.replace(/\{[^}]+\}/g, ""))) fail(`a path parameter is missing its closing "}".`);
  const unsafe = unsafePathReason(path);
  if (unsafe) fail(`${unsafe}, which could reach outside your API's folder.`);

  const query: SampleParam[] = [];
  if (rawQuery) {
    for (const pair of rawQuery.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      let name = decode(rawName, `the query name "${rawName}"`);
      const value = eq === -1 ? "" : decode(pair.slice(eq + 1).replace(/\+/g, " "), `the value of "${name}"`);
      let required = true;
      if (name.endsWith("?")) {
        required = false;
        name = name.slice(0, -1);
      }
      if (!NAME.test(name)) fail(`"${name}" is not a valid query parameter name.`);
      if (name === "body") fail(`a parameter named "body" is reserved for the request body. Rename it.`);
      keyParam(name, value);
      if (value === "") fail(`give an example value for "${name}", like ${name}=example.`);
      if (query.some((p) => p.name === name) || pathParams.some((p) => p.name === name)) fail(`"${name}" appears twice.`);
      query.push({ name, value, required });
    }
  }

  let body: unknown;
  if (bodyText) {
    if (method === "GET" || method === "DELETE") fail(`a ${method} request can't have a body here.`);
    try {
      body = JSON.parse(bodyText);
    } catch {
      fail(`the request body must be JSON, for example {"q": "ada"}.`);
    }
  }
  // Named key parameters were refused above with their name; this catches a key under any other name or in the body.
  if (looksLikeSecret(line)) fail(`this line looks like it has a key, token or password in it. ${KEY_ADVICE}`);
  return { method, path, pathParams, query, ...(body !== undefined ? { body } : {}) };
}

/** One sample per non-empty line. Lines starting with # are comments. */
export function parseSampleLines(text: unknown): Sample[] {
  if (typeof text !== "string" || text.trim() === "") throw new SampleError("Add at least one example request, for example GET /price?symbol=ADA");
  const lines = text.split(/\r?\n/).map((l, i) => ({ l: l.trim(), n: i + 1 })).filter(({ l }) => l && !l.startsWith("#"));
  if (lines.length === 0) throw new SampleError("Add at least one example request, for example GET /price?symbol=ADA");
  if (lines.length > MAX_SAMPLE_LINES) throw new SampleError(`Give at most ${MAX_SAMPLE_LINES} example requests.`);
  return lines.map(({ l, n }) => parseLine(l, n));
}

type Json = Record<string, unknown>;

/** A value written in a URL, typed the way a buyer would send it: integer, number or boolean when exact. */
function typedExample(value: string): { type: string; example: unknown } {
  if (/^-?(0|[1-9]\d{0,15})$/.test(value)) return { type: "integer", example: Number(value) };
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(value) && String(Number(value)) === value) return { type: "number", example: Number(value) };
  if (value === "true" || value === "false") return { type: "boolean", example: value === "true" };
  return { type: "string", example: value };
}

/** A JSON Schema for an example JSON value. Every key seen is required; arrays take the first item's shape. */
export function schemaOfExample(v: unknown, depth = 0): Json {
  if (depth > 8) return {};
  if (v === null) return { type: "null" };
  if (Array.isArray(v)) return v.length ? { type: "array", items: schemaOfExample(v[0], depth + 1) } : { type: "array" };
  if (typeof v === "object") {
    const props: Json = {};
    for (const [k, x] of Object.entries(v as Json)) props[k] = schemaOfExample(x, depth + 1);
    return { type: "object", properties: props, required: Object.keys(props) };
  }
  if (typeof v === "number") return { type: Number.isInteger(v) ? "integer" : "number" };
  return { type: typeof v };
}

/** Merges two inferred schemas for the same parameter: the same type keeps it, different types widen to string. */
function mergeParamType(a: string, b: string): string {
  if (a === b) return a;
  if ((a === "integer" && b === "number") || (a === "number" && b === "integer")) return "number";
  return "string";
}

const key = (s: Sample) => `${s.method} ${s.path}`;

/**
 * The OpenAPI 3.1 document for a list of samples. Lines with the same method and path become one operation
 * with every example. A parameter is required only if it is required on every line that has it, and present
 * on all of them.
 */
export function specFromSamples(a: { title: string; base: string; samples: Sample[] }): Json {
  const groups = new Map<string, Sample[]>();
  for (const s of a.samples) groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);
  const paths: Record<string, Json> = {};
  for (const group of groups.values()) {
    const { method, path } = group[0];
    const params = new Map<string, { in: "path" | "query"; type: string; examples: unknown[]; required: boolean; seen: number }>();
    for (const s of group) {
      for (const [where, list] of [["path", s.pathParams], ["query", s.query]] as const) {
        for (const p of list) {
          const t = typedExample(p.value);
          const prev = params.get(p.name);
          if (prev) {
            prev.type = mergeParamType(prev.type, t.type);
            prev.examples.push(t.example);
            prev.required &&= p.required;
            prev.seen += 1;
          } else {
            params.set(p.name, { in: where, type: t.type, examples: [t.example], required: p.required, seen: 1 });
          }
        }
      }
    }
    const parameters = [...params.entries()].map(([name, p]) => {
      const examples = [...new Set((p.type === "string" ? p.examples.map(String) : p.examples).map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x));
      return {
        name,
        in: p.in,
        required: p.in === "path" || (p.required && p.seen === group.length),
        schema: { type: p.type, examples },
      };
    });
    const bodies = group.map((s) => s.body).filter((b) => b !== undefined);
    const op: Json = {
      summary: `${method} ${path}`,
      ...(parameters.length ? { parameters } : {}),
      ...(bodies.length
        ? { requestBody: { required: bodies.length === group.length, content: { "application/json": { schema: { ...schemaOfExample(bodies[0]), examples: bodies } } } } }
        : {}),
      responses: { "200": { description: "OK" } },
    };
    paths[path] = { ...(paths[path] ?? {}), [method.toLowerCase()]: op };
  }
  return { openapi: "3.1.0", info: { title: a.title, version: "1" }, servers: [{ url: a.base }], paths };
}
