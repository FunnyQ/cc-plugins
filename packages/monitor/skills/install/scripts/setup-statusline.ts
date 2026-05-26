#!/usr/bin/env bun
// Wires the statusline collector into ~/.claude/settings.json so the dashboard
// can capture live rate_limits. Idempotent; preserves any existing statusLine
// by wrapping it via TOKEN_ATLAS_STATUSLINE_COMMAND. Reused by setup.ts and run
// directly by the dashboard skill after the user approves (see SKILL.md).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { decideStatusLine, type StatusLineConfig } from "./statusline-decision";

const SETTINGS = join(homedir(), ".claude", "settings.json");
// The collector lives in the usage-dashboard skill, one over from here.
const COLLECTOR_COMMAND = `bun ${resolve(import.meta.dir, "..", "..", "usage-dashboard", "scripts", "statusline-collector.ts")}`;

export type ApplyResult =
  | {
      ok: true;
      skipped: boolean;
      preserved: string | null;
      backup: string | null;
    }
  | { ok: false; error: string };

// Apply the statusline wiring. Returns a structured result so callers (setup.ts)
// can decide how to report; the CLI below prints in the original format.
export function applyStatusline(): ApplyResult {
  let settings: Record<string, unknown> = {};
  if (existsSync(SETTINGS)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS, "utf-8"));
    } catch {
      // Never clobber a config we can't parse — the user could lose settings.
      return {
        ok: false,
        error: `Couldn't parse ${SETTINGS}. Fix the JSON or wire the statusLine manually:\n  "statusLine": { "type": "command", "command": "${COLLECTOR_COMMAND}", "padding": 0 }`,
      };
    }
  }

  const statusLine = (settings.statusLine ?? {}) as StatusLineConfig;
  const decision = decideStatusLine(statusLine, COLLECTOR_COMMAND);
  if (decision.action === "skip") {
    return { ok: true, skipped: true, preserved: null, backup: null };
  }

  const backup = existsSync(SETTINGS) ? `${SETTINGS}.bak` : null;
  if (backup) copyFileSync(SETTINGS, backup);

  settings.statusLine = {
    ...statusLine,
    type: "command",
    command: decision.command,
    padding: decision.padding,
  };
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);

  return { ok: true, skipped: false, preserved: decision.preserved, backup };
}

// CLI: run by the dashboard skill after user approval.
if (import.meta.main) {
  const result = applyStatusline();
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.skipped) {
    console.log("✓ statusLine already runs the collector — nothing to do.");
    process.exit(0);
  }
  console.log(`✓ Wired statusLine collector into ${SETTINGS}`);
  if (result.preserved) {
    console.log(`  Preserved your existing line: ${result.preserved}`);
    console.log(`  (re-runs it via TOKEN_ATLAS_STATUSLINE_COMMAND)`);
  }
  if (result.backup) console.log(`  Backup: ${result.backup}`);
  console.log("  Restart Claude Code so the new status line takes effect.");
}
