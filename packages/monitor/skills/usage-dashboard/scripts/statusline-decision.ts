// Pure decision for wiring the statusline collector into an existing
// settings.json `statusLine` block. Extracted from setup-statusline.ts so the
// branching (skip vs preserve-and-wrap vs fresh) is unit-testable without
// touching the filesystem — the collector-exists check is injected.

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

// Decide how to wire `collectorCommand` into `statusLine`.
//
// - If the current command already references a collector script that still
//   exists on disk (per `collectorExists`), there's nothing to do.
// - Otherwise wire the collector, preserving any non-collector command by
//   running it as the collector's inner command (via the env var the collector
//   reads); a stale collector reference is replaced outright (not preserved).
export function decideStatusLine(
  statusLine: StatusLineConfig,
  collectorCommand: string,
  collectorExists: (path: string) => boolean,
): StatusLineDecision {
  const existing =
    typeof statusLine.command === "string" ? statusLine.command : null;
  const referencedCollector =
    existing?.match(/(\S*statusline-collector\.ts)/)?.[1] ?? null;

  if (referencedCollector && collectorExists(referencedCollector)) {
    return { action: "skip" };
  }

  // Preserve a non-collector statusline by running it as the collector's inner
  // command; a stale collector reference is dropped (don't re-wrap it).
  const preserved = existing && !referencedCollector ? existing : null;
  const command = preserved
    ? `TOKEN_ATLAS_STATUSLINE_COMMAND='${preserved}' ${collectorCommand}`
    : collectorCommand;
  const padding =
    typeof statusLine.padding === "number" ? statusLine.padding : 0;

  return { action: "write", command, padding, preserved };
}
