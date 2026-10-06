/** Script arguments without the leading `--` that `pnpm <script> -- --flag` forwards (node's parseArgs rejects it). */
export function cliArgs(argv: string[] = process.argv): string[] {
  const args = argv.slice(2);
  return args[0] === "--" ? args.slice(1) : args;
}
