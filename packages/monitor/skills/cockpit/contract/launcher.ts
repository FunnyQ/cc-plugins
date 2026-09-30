import { join, resolve } from "node:path";

export type Proc = "server" | "channel" | "cli" | "hook";
const binary = process.env.COCKPIT_BIN;
export const underTest: "ts" | "rust" = binary ? "rust" : "ts";
export const PLUGIN_ROOT = resolve(import.meta.dir, "../../..");
export const SCRIPTS_DIR = join(PLUGIN_ROOT, "skills/cockpit/scripts");

export function command(proc: Proc, argv: string[]): string[] {
  if (binary) return proc === "cli" ? [binary, ...argv] : [binary, proc, ...argv];
  if (proc === "server" || proc === "channel") {
    return ["bun", join(SCRIPTS_DIR, `cockpit-${proc}.ts`), ...argv];
  }
  if (proc === "cli") {
    return argv[0] === "find-session"
      ? ["bun", join(SCRIPTS_DIR, "find-session.ts"), ...argv.slice(1)]
      : ["bun", join(SCRIPTS_DIR, "cockpit.ts"), ...argv];
  }
  if (argv[0] === "session-start") return ["bun", join(SCRIPTS_DIR, "decision-log-start.ts")];
  if (argv[0] === "stop") return ["bun", join(SCRIPTS_DIR, "scribe-nudge.ts")];
  throw new Error(`Unknown cockpit hook: ${argv[0]}`);
}
