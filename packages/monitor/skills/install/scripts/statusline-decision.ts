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
// - If the current command already points at the *exact* live collector path,
//   there's nothing to do.
// - Any other collector reference — a path that no longer exists, or an older
//   plugin-cache version like `.../monitor/3.1.0/...` — is re-pointed to the
//   live collector (dropped, not wrapped). This is what fixes version drift:
//   the old cache dir may still exist on disk, so an existence check isn't
//   enough; only an exact match to the current path counts as wired.
// - A non-collector command is preserved by running it as the collector's inner
//   command (via the env var the collector reads).
export function decideStatusLine(
  statusLine: StatusLineConfig,
  collectorCommand: string,
): StatusLineDecision {
  const existing =
    typeof statusLine.command === "string" ? statusLine.command : null;
  const liveCollector =
    collectorCommand.match(/(\S*statusline-collector\.ts)/)?.[1] ?? null;
  const referencedCollector =
    existing?.match(/(\S*statusline-collector\.ts)/)?.[1] ?? null;

  if (referencedCollector && referencedCollector === liveCollector) {
    return { action: "skip" };
  }

  // Preserve a non-collector statusline by running it as the collector's inner
  // command; any collector reference (stale or drifted) is dropped.
  const preserved = existing && !referencedCollector ? existing : null;
  const command = preserved
    ? `TOKEN_ATLAS_STATUSLINE_COMMAND='${preserved}' ${collectorCommand}`
    : collectorCommand;
  const padding =
    typeof statusLine.padding === "number" ? statusLine.padding : 0;

  return { action: "write", command, padding, preserved };
}
