/** Script arguments without the leading `--` that `pnpm <script> -- --flag` forwards (node's parseArgs rejects it). */
export function cliArgs(argv: string[] = process.argv): string[] {
  const args = argv.slice(2);
  return args[0] === "--" ? args.slice(1) : args;
}

/**
 * The request's query or job input: each `--query name=value` (repeatable), or `{ symbol }` when none is
 * given, so the demo price API keeps working with `--symbol`. Throws on an entry without a name and "=".
 */
export function queryArgs(pairs: string[] | undefined, symbol: string): Record<string, string> {
  if (!pairs?.length) return { symbol };
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error(`--query expects name=value, got "${pair}"`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}
