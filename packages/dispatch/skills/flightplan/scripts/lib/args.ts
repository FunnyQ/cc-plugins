/**
 * Flag parsing shared by the flightplan CLIs.
 *
 * One definition on purpose: the three copies this replaced had drifted — two
 * returned the next token when the value was missing, so `--log --attempt 3`
 * silently set the log file to `"--attempt"`. Erroring is the contract here.
 */

/**
 * The value following `name`, or undefined when the flag is absent.
 *
 * Exits 2 when the flag is present with nothing usable after it — either no
 * token at all, or the next flag. A caller that wants a boolean flag should use
 * `argv.includes(name)` instead.
 *
 * `allowDashValue` opts out of the next-flag check for free-text flags whose
 * value may legitimately begin with `--` (flightlog's `--message`). Only the
 * end-of-argv case errors for those.
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
