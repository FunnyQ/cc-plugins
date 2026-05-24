#!/usr/bin/env bun
// Wires the statusline collector into ~/.claude/settings.json so the dashboard
// can capture live rate_limits. Idempotent; preserves any existing statusLine
// by wrapping it via TOKEN_ATLAS_STATUSLINE_COMMAND. Run by the dashboard skill
// only after the user approves (see SKILL.md).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideStatusLine, type StatusLineConfig } from "./statusline-decision";

const HOME = homedir();
const SETTINGS = join(HOME, ".claude", "settings.json");
const COLLECTOR_COMMAND = `bun ${join(import.meta.dir, "statusline-collector.ts")}`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let settings: Record<string, unknown> = {};
if (existsSync(SETTINGS)) {
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf-8"));
  } catch {
    // Never clobber a config we can't parse — the user could lose settings.
    fail(
      `Couldn't parse ${SETTINGS}. Fix the JSON or wire the statusLine manually:\n  "statusLine": { "type": "command", "command": "${COLLECTOR_COMMAND}", "padding": 0 }`,
    );
  }
}

const statusLine = (settings.statusLine ?? {}) as StatusLineConfig;
const decision = decideStatusLine(statusLine, COLLECTOR_COMMAND, existsSync);

if (decision.action === "skip") {
  console.log("✓ statusLine already runs the collector — nothing to do.");
  process.exit(0);
}

if (existsSync(SETTINGS)) {
  copyFileSync(SETTINGS, `${SETTINGS}.bak`);
}

settings.statusLine = {
  ...statusLine,
  type: "command",
  command: decision.command,
  padding: decision.padding,
};
writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);

console.log(`✓ Wired statusLine collector into ${SETTINGS}`);
if (decision.preserved) {
  console.log(`  Preserved your existing line: ${decision.preserved}`);
  console.log(`  (re-runs it via TOKEN_ATLAS_STATUSLINE_COMMAND)`);
}
console.log(`  Backup: ${SETTINGS}.bak`);
console.log("  Restart Claude Code so the new status line takes effect.");
