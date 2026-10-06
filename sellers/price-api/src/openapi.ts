export function buildOpenApi(serverUrl: string): Record<string, unknown> {
  return { openapi: "3.1.0", info: { title: "Hirakumi Demo Price API", version: "1.0.0" }, servers: [{ url: serverUrl }], paths: {} };
}
