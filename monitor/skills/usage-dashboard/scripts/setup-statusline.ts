#!/usr/bin/env bun
// Wires the statusline collector into ~/.claude/settings.json so the dashboard
// can capture live rate_limits. Idempotent; preserves any existing statusLine
// by wrapping it via TOKEN_ATLAS_STATUSLINE_COMMAND. Run by the dashboard skill
// only after the user approves (see SKILL.md).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

const statusLine = (settings.statusLine ?? {}) as Record<string, unknown>;
const existing =
  typeof statusLine.command === "string" ? statusLine.command : null;
const referencedCollector =
  existing?.match(/(\S*statusline-collector\.ts)/)?.[1] ?? null;

if (referencedCollector && existsSync(referencedCollector)) {
  console.log("✓ statusLine already runs the collector — nothing to do.");
  process.exit(0);
}

// Preserve a non-collector statusline by running it as the collector's inner
// command; otherwise fall back to the collector's own default (ccstatusline).
const command =
  existing && !referencedCollector
    ? `TOKEN_ATLAS_STATUSLINE_COMMAND='${existing}' ${COLLECTOR_COMMAND}`
    : COLLECTOR_COMMAND;

if (existsSync(SETTINGS)) {
  copyFileSync(SETTINGS, `${SETTINGS}.bak`);
}

const padding = typeof statusLine.padding === "number" ? statusLine.padding : 0;
settings.statusLine = { ...statusLine, type: "command", command, padding };
writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);

console.log(`✓ Wired statusLine collector into ${SETTINGS}`);
if (existing) {
  console.log(`  Preserved your existing line: ${existing}`);
  console.log(`  (re-runs it via TOKEN_ATLAS_STATUSLINE_COMMAND)`);
}
console.log(`  Backup: ${SETTINGS}.bak`);
console.log("  Restart Claude Code so the new status line takes effect.");
