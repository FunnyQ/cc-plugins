import { homedir } from "node:os";
import { join } from "node:path";

export function openCodeDb(): string {
  return (
    process.env.COCKPIT_OPENCODE_DB ||
    join(
      process.env.OPENCODE_DATA_DIR ||
        join(homedir(), ".local", "share", "opencode"),
      "opencode.db",
    )
  );
}

export function openCodeTimestampMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}
