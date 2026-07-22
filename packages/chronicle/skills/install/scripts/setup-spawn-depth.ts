#!/usr/bin/env bun

// Wires CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH into ~/.claude/settings.json so
// Chronicle's orchestrators can spawn their children. Idempotent; preserves
// unrelated settings and never lowers a value the user already raised.
//
// Modes: --check (default) | --dry-run | --apply | --session-check

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ENV_KEY,
  REQUIRED_DEPTH,
  decideSpawnDepth,
} from "./spawn-depth-decision";

const SETTINGS = join(homedir(), ".claude", "settings.json");

const MANUAL_HINT = `Add this to ${SETTINGS} by hand:\n  "env": { "${ENV_KEY}": "${REQUIRED_DEPTH}" }`;

type Loaded =
  { ok: true; settings: unknown; raw: string } | { ok: false; error: string };

function loadSettings(): Loaded {
  if (!existsSync(SETTINGS)) return { ok: true, settings: {}, raw: "" };
  const raw = readFileSync(SETTINGS, "utf8");
  try {
    return { ok: true, settings: JSON.parse(raw), raw };
  } catch {
    return {
      ok: false,
      error: `Couldn't parse ${SETTINGS}. Fix the JSON, then re-run.\n${MANUAL_HINT}`,
    };
  }
}

function applyDepth(settings: Record<string, unknown>, value: number): string {
  const env = { ...((settings.env ?? {}) as Record<string, unknown>) };
  env[ENV_KEY] = String(value);
  return `${JSON.stringify({ ...settings, env }, null, 2)}\n`;
}

function main() {
  const sessionCheck = process.argv.includes("--session-check");
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply") || sessionCheck;

  const loaded = loadSettings();
  if (!loaded.ok) {
    // A SessionStart hook must never nag about a file it can't safely touch.
    if (!sessionCheck) console.error(loaded.error);
    process.exit(sessionCheck ? 0 : 1);
  }

  const decision = decideSpawnDepth(loaded.settings);

  if (decision.action === "ok") {
    if (!sessionCheck) console.log(`✓ ${decision.reason}`);
    return;
  }

  if (decision.action === "unparsable") {
    if (!sessionCheck) console.error(`${decision.reason}\n${MANUAL_HINT}`);
    process.exit(sessionCheck ? 0 : 1);
  }

  const next = applyDepth(
    loaded.settings as Record<string, unknown>,
    decision.value,
  );

  if (dryRun || !apply) {
    console.log(decision.reason);
    console.log(`Would set "${ENV_KEY}": "${decision.value}" in ${SETTINGS}`);
    if (dryRun) process.stdout.write(next);
    return;
  }

  if (loaded.raw) copyFileSync(SETTINGS, `${SETTINGS}.bak-chronicle`);
  writeFileSync(SETTINGS, next);

  // The env var is read when a session starts, so the session that triggered
  // this write is still running without it. Say so plainly — otherwise the
  // next /chronicle:commit fails again and looks unfixed.
  console.log(
    `Chronicle set "${ENV_KEY}": "${decision.value}" in ${SETTINGS} (${decision.reason})`,
  );
  console.log(
    "Restart Claude Code for it to take effect — until then Chronicle's commit/pr/release flows will still fail to spawn their agents.",
  );
}

main();
