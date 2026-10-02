import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type Proc = "server" | "cli" | "hook";
export const PLUGIN_ROOT = resolve(import.meta.dir, "../../..");
export const SCRIPTS_DIR = join(PLUGIN_ROOT, "skills/cockpit/scripts");
// The ported TS processes are deleted, so a missing binary must fail the suite.
const binary = process.env.COCKPIT_BIN || join(PLUGIN_ROOT, "cockpit-rs/target/release/cockpit");
if (!process.env.COCKPIT_BIN && !existsSync(binary)) {
  throw new Error("contract suite: no binary — run cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml or set COCKPIT_BIN");
}

// Spawned children inherit the resolved binary path.
process.env.COCKPIT_BIN = binary;

export function command(proc: Proc, argv: string[]): string[] {
  return proc === "cli" ? [binary, ...argv] : [binary, proc, ...argv];
}
