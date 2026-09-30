// Pure decision for wiring the statusline collector into an existing
// settings.json `statusLine` block. Extracted from setup-statusline.ts so the
// branching (skip vs preserve-and-wrap vs fresh) is unit-testable without
// touching the filesystem — the collector-exists check is injected.
//
// The two detection regexes live here and nowhere else: install.ts and
// setup.ts import them, because a second literal drifts and makes "is it
// wired?" disagree with what the writer produces.

// New form: `<path>/skills/cockpit/bin/cockpit atlas statusline`. Quotes
// around the path are matched too: a hand-quoted shim read as a user command
// would be wrapped around the collector itself.
export const SHIM_COLLECTOR_RE =
  /["']?([^\s"']*\/skills\/cockpit\/bin\/cockpit)["']? atlas statusline\b/;
// Old form: the removed `bun <path>/statusline-collector.ts`. The optional
// `bun` (bare or absolute, quoted or not) and the quotes around the script are
// part of the match so a rewrite replaces the whole collector part.
export const TS_COLLECTOR_RE =
  /(?:(?<!\S)["']?(?:[^\s"']*\/)?bun["']?\s+)?["']?([^\s"']*statusline-collector\.ts)["']?/;
const TS_COLLECTOR_SUFFIX =
  "/skills/usage-dashboard/scripts/statusline-collector.ts";

export type StatusLineConfig = {
  command?: unknown;
  padding?: unknown;
  [key: string]: unknown;
};

export type StatusLineDecision =
  | { action: "skip" } // already runs the collector — nothing to do
  | {
      action: "write";
      command: string;
      padding: number;
      // The pre-existing non-collector command we wrapped, or null when there
      // was nothing to preserve. Surfaced so the caller can report it.
      preserved: string | null;
    };

// A function replacement, so a `$` in the collector path is never read as a
// replacement pattern.
function replaceCollector(
  command: string,
  re: RegExp,
  collectorCommand: string,
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
    return `${open}${collectorCommand}${close}`;
  });
}

// Stale collectors are re-pointed in place so a wrapped user command survives.
export function decideStatusLine(
  statusLine: StatusLineConfig,
  collectorCommand: string,
): StatusLineDecision {
  const existing =
    typeof statusLine.command === "string" ? statusLine.command : null;
  const liveShim = collectorCommand.match(SHIM_COLLECTOR_RE)?.[1] ?? null;
  const referencedShim = existing?.match(SHIM_COLLECTOR_RE)?.[1] ?? null;
  const padding =
    typeof statusLine.padding === "number" ? statusLine.padding : 0;

  if (referencedShim && referencedShim === liveShim) {
    return { action: "skip" };
  }
  if (existing && (referencedShim || TS_COLLECTOR_RE.test(existing))) {
    const re = referencedShim ? SHIM_COLLECTOR_RE : TS_COLLECTOR_RE;
    const command = replaceCollector(existing, re, collectorCommand);
    return { action: "write", command, padding, preserved: null };
  }

  const preserved = existing || null;
  const command = preserved
    ? `TOKEN_ATLAS_STATUSLINE_COMMAND='${preserved}' ${collectorCommand}`
    : collectorCommand;
  return { action: "write", command, padding, preserved };
}

// Only a monitor-owned TS collector migrates: its file is gone once the clone
// updates, and the hook must never touch a statusline it does not own.
export function migrateCollectorCommand(
  command: string,
  collectorCommand: string,
): string | null {
  const path = command.match(TS_COLLECTOR_RE)?.[1];
  if (!path?.endsWith(TS_COLLECTOR_SUFFIX)) return null;
  return replaceCollector(command, TS_COLLECTOR_RE, collectorCommand);
}
