import { join } from "node:path";

export type AtlasSub =
  | "serve"
  | "stats"
  | "live"
  | "rollup-update"
  | "statusline"
  | "push-usage";

export const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");

const TS_SCRIPT: Record<AtlasSub, string> = {
  serve: "atlas-server.ts",
  stats: "api.ts",
  live: "live.ts",
  "rollup-update": "rollup-update.ts",
  statusline: "statusline-collector.ts",
  "push-usage": "push-usage.ts",
};

// Unlike cockpit's launcher, an unset COCKPIT_BIN is not an error: it means "test the TS".
export function isRust(): boolean {
  return !!process.env.COCKPIT_BIN;
}

export function atlasCommand(sub: AtlasSub, args: string[] = []): string[] {
  const binary = process.env.COCKPIT_BIN;
  if (binary) return [binary, "atlas", sub, ...args];
  return ["bun", join(SCRIPTS_DIR, TS_SCRIPT[sub]), ...args];
}
