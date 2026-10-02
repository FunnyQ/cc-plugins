// Pure rewrite that takes the retired statusline collector back out of a
// settings.json `statusLine.command`. The monitor mod's session.measure hook
// feeds the rate-limit cache now, so the collector only stands between Claude
// Code and the command it forwarded to.

// New form (the subcommand is removed from the binary): `<path>/skills/cockpit/bin/cockpit atlas statusline`. Quotes
// around the path are matched too.
export const SHIM_COLLECTOR_RE =
  /["']?([^\s"']*\/skills\/cockpit\/bin\/cockpit)["']? atlas statusline\b/;
// Old form: the removed `bun <path>/statusline-collector.ts`. The optional
// `bun` (bare or absolute, quoted or not) and the quotes around the script are
// part of the match so a rewrite replaces the whole collector part.
const TS_COLLECTOR_RE =
  /(?:(?<!\S)["']?(?:[^\s"']*\/)?bun["']?\s+)?["']?([^\s"']*statusline-collector\.ts)["']?/;
const TS_COLLECTOR_SUFFIX =
  "/skills/usage-dashboard/scripts/statusline-collector.ts";
// The removed collector's forward target when no TOKEN_ATLAS_STATUSLINE_COMMAND was set.
const DEFAULT_INNER = "bunx -y ccstatusline@latest";
// The only prefix the installer ever wrote; it did not escape single quotes.
const WRAP_RE = /TOKEN_ATLAS_STATUSLINE_COMMAND='([^']*)'\s+$/;

// A function replacement, so a `$` in the replacement is never read as a
// replacement pattern.
function replaceCollector(
  command: string,
  re: RegExp,
  replacement: string,
): string {
  return command.replace(re, (m) => {
    // A quote closed outside the match, or one enclosing a multi-word match,
    // belongs to the user's command (e.g. `hud statusline 'bun …'`), so keep it.
    const outer = /\s/.test(m.slice(1, -1));
    const first = m[0];
    const last = m[m.length - 1];
    const next = m.indexOf(first, 1);
    const prev = m.lastIndexOf(last, m.length - 2);
    const open =
      (first === '"' || first === "'") &&
      (next === -1 || (next === m.length - 1 && outer))
        ? first
        : "";
    const close =
      (last === '"' || last === "'") && (prev === -1 || (prev === 0 && outer))
        ? last
        : "";
    return `${open}${replacement}${close}`;
  });
}

// The command with the collector replaced by what it forwarded to, or null
// when it runs no monitor-owned collector.
export function unwrapCollectorCommand(command: string): string | null {
  const shim = SHIM_COLLECTOR_RE.exec(command);
  const ts = shim ? null : TS_COLLECTOR_RE.exec(command);
  const match = shim ?? (ts?.[1].endsWith(TS_COLLECTOR_SUFFIX) ? ts : null);
  if (!match) return null;
  const before = command.slice(0, match.index);
  const wrap = WRAP_RE.exec(before);
  if (wrap) {
    return (
      before.slice(0, wrap.index) +
      wrap[1] +
      command.slice(match.index + match[0].length)
    );
  }
  return replaceCollector(
    command,
    shim ? SHIM_COLLECTOR_RE : TS_COLLECTOR_RE,
    DEFAULT_INNER,
  );
}
