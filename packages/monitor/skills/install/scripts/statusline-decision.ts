// Pure decision for wiring the statusline collector into an existing
// settings.json `statusLine` block. Extracted from setup-statusline.ts so the
// branching (skip vs preserve-and-wrap vs fresh) is unit-testable without
// touching the filesystem — the collector-exists check is injected.
//
// The two detection regexes live here and nowhere else: install.ts and
// setup.ts import them, because a second literal drifts and makes "is it
// wired?" disagree with what the writer produces.

// New form: `<path>/skills/cockpit/bin/cockpit atlas statusline`.
export const SHIM_COLLECTOR_RE =
  /(\S*\/skills\/cockpit\/bin\/cockpit) atlas statusline\b/;
// Old form: the removed `bun <path>/statusline-collector.ts`. The optional
// `bun ` is part of the match so a rewrite replaces the whole collector part.
export const TS_COLLECTOR_RE = /(?:\bbun\s+)?(\S*statusline-collector\.ts)/;
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
  return command.replace(re, () => collectorCommand);
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
  if (existing && referencedShim) {
    const command = replaceCollector(
      existing,
      SHIM_COLLECTOR_RE,
      collectorCommand,
    );
    return { action: "write", command, padding, preserved: null };
  }
  if (existing && TS_COLLECTOR_RE.test(existing)) {
    const command = replaceCollector(
      existing,
      TS_COLLECTOR_RE,
      collectorCommand,
    );
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
