/** Hosts that serve files, never an API: a link there is an OpenAPI file, and the API must run somewhere else. */
export const FILE_HOSTS: ReadonlySet<string> = new Set([
  "raw.githubusercontent.com", "gist.githubusercontent.com", "github.com", "gist.github.com", "gitlab.com", "bitbucket.org",
  "cdn.jsdelivr.net", "pastebin.com",
]);
