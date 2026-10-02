import { existsSync } from "node:fs";
import { join } from "node:path";

export type AtlasSub =
  | "serve"
  | "stats"
  | "live"
  | "rollup-update"
  | "statusline"
  | "measure"
  | "push-usage";

export const DEFAULT_BIN = join(
  import.meta.dir,
  "../../../cockpit-rs/target/release/cockpit",
);

// No TS fallback: the TS engine is deleted, and a silent skip would pass a suite that tested nothing.
if (!process.env.COCKPIT_BIN && !existsSync(DEFAULT_BIN)) {
  throw new Error(
    "atlas contract suite: no binary — run cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml or set COCKPIT_BIN",
  );
}

export function atlasCommand(sub: AtlasSub, args: string[] = []): string[] {
  return [process.env.COCKPIT_BIN || DEFAULT_BIN, "atlas", sub, ...args];
}
