/**
 * Flag parsing shared by the flightplan CLIs.
 *
 * One definition on purpose: the three copies this replaced had drifted — two
 * returned the next token when the value was missing, so `--log --attempt 3`
 * silently set the log file to `"--attempt"`. Erroring is the contract here.
 */

export function flagValue(
  argv: string[],
  name: string,
  opts: { allowDashValue?: boolean } = {},
): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || (!opts.allowDashValue && v.startsWith("--"))) {
    process.stderr.write(`Missing value after ${name}\n`);
    process.exit(2);
  }
  return v;
}
