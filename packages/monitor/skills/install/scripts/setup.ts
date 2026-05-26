#!/usr/bin/env bun
//
// monitor:install engine — the single entry that checks every prerequisite for
// both skills and wires the two configs a non-dev user otherwise edits by hand:
//   1. cockpit-channel MCP server in ~/.claude.json (absolute path, since that
//      file does NOT expand $CLAUDE_PLUGIN_ROOT)
//   2. usage-dashboard statusline collector in ~/.claude/settings.json
//
// Checks reuse install.ts (dashboard) + the channel checks here; the statusline
// write reuses setup-statusline.ts. Only the cockpit-channel piece is owned here.
//
// Modes:
//   (default) / --check   read-only status report, exit 1 if a required check fails
//   --dry-run             print exactly what --apply would change, write nothing
//   --apply               apply both pieces
//   --apply-channel       apply only the cockpit-channel MCP registration
//   --apply-statusline    apply only the statusline collector wiring
//
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Check, dashboardChecks, printReport } from "./install";
import { applyStatusline } from "./setup-statusline";
import { decideStatusLine, type StatusLineConfig } from "./statusline-decision";

const HOME = homedir();
// Absolute path a user can paste into ~/.claude.json (no $CLAUDE_PLUGIN_ROOT there).
const CHANNEL_SCRIPT = resolve(
  import.meta.dir,
  "..",
  "..",
  "cockpit",
  "scripts",
  "cockpit-channel.ts",
);
const COLLECTOR_COMMAND = `bun ${resolve(import.meta.dir, "..", "..", "usage-dashboard", "scripts", "statusline-collector.ts")}`;
const CLAUDE_JSON = join(HOME, ".claude.json");
const SETTINGS_JSON = join(HOME, ".claude", "settings.json");
const MIN_CLAUDE_VERSION = "2.1.80"; // channels research-preview floor

// --- helpers ----------------------------------------------------------------
function readJson(path: string): { data: any; readable: boolean } {
  if (!existsSync(path)) return { data: {}, readable: true };
  try {
    return { data: JSON.parse(readFileSync(path, "utf-8")), readable: true };
  } catch {
    return { data: null, readable: false };
  }
}

function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${path}.bak-${stamp}`;
  copyFileSync(path, dest);
  return dest;
}

function claudeVersion(): string | null {
  try {
    const out = Bun.spawnSync(["claude", "--version"]).stdout.toString();
    return out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function versionGte(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return true;
}

function channelRegistered(): boolean {
  const { data } = readJson(CLAUDE_JSON);
  const args = data?.mcpServers?.["cockpit-channel"]?.args;
  return Array.isArray(args) && args.includes(CHANNEL_SCRIPT);
}

// --- cockpit channel checks (the piece this skill owns) ---------------------
function channelChecks(): Check[] {
  const checks: Check[] = [];
  const add = (
    label: string,
    ok: boolean,
    level: Check["level"],
    hint?: string,
  ) => checks.push({ label, ok, level, hint });

  const ver = claudeVersion();
  add(
    `claude CLI ${ver ? `(${ver})` : ""}`.trim(),
    ver !== null,
    "optional",
    "Claude Code not found on PATH — the cockpit channel needs it.",
  );
  if (ver) {
    add(
      `claude >= ${MIN_CLAUDE_VERSION} (channels)`,
      versionGte(ver, MIN_CLAUDE_VERSION),
      "optional",
      `Channels need Claude Code ${MIN_CLAUDE_VERSION}+. Update Claude Code to use the cockpit send box.`,
    );
  }
  add(
    "cockpit-channel script exists",
    existsSync(CHANNEL_SCRIPT),
    "required",
    `Expected at ${CHANNEL_SCRIPT}`,
  );
  add(
    "cockpit-channel registered in ~/.claude.json",
    channelRegistered(),
    "optional",
    `Run: bun ${import.meta.path} --apply-channel`,
  );
  return checks;
}

// --- apply: cockpit-channel MCP ---------------------------------------------
function applyChannel(dryRun: boolean): boolean {
  if (channelRegistered()) {
    console.log("○ cockpit-channel already registered — nothing to do.");
    return true;
  }
  const { data, readable } = readJson(CLAUDE_JSON);
  if (!readable) {
    console.log(`✗ Couldn't parse ${CLAUDE_JSON} — fix it first.`);
    return false;
  }
  const next = { ...data };
  next.mcpServers = { ...(next.mcpServers ?? {}) };
  next.mcpServers["cockpit-channel"] = {
    command: "bun",
    args: [CHANNEL_SCRIPT],
  };

  if (dryRun) {
    console.log(`Would write to ${CLAUDE_JSON}:`);
    console.log(
      JSON.stringify(
        {
          mcpServers: { "cockpit-channel": next.mcpServers["cockpit-channel"] },
        },
        null,
        2,
      ),
    );
    return true;
  }
  const bak = backup(CLAUDE_JSON);
  writeFileSync(CLAUDE_JSON, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`✓ Registered cockpit-channel in ${CLAUDE_JSON}`);
  if (bak) console.log(`   (backup: ${bak})`);
  return true;
}

// --- apply: statusline collector (delegates to setup-statusline) ------------
function applyStatuslinePiece(dryRun: boolean): boolean {
  // Read just the statusLine block to detect skip / preview the write.
  let statusLine: StatusLineConfig = {};
  if (existsSync(SETTINGS_JSON)) {
    try {
      statusLine = (JSON.parse(readFileSync(SETTINGS_JSON, "utf-8"))
        .statusLine ?? {}) as StatusLineConfig;
    } catch {
      console.log(`✗ Couldn't parse ${SETTINGS_JSON} — fix it first.`);
      return false;
    }
  }
  const decision = decideStatusLine(statusLine, COLLECTOR_COMMAND, existsSync);
  if (decision.action === "skip") {
    console.log("○ statusline collector already wired — nothing to do.");
    return true;
  }
  if (dryRun) {
    console.log(`Would set statusLine.command in ${SETTINGS_JSON}:`);
    console.log(`   ${decision.command}`);
    return true;
  }
  const result = applyStatusline();
  if (!result.ok) {
    console.log(`✗ ${result.error}`);
    return false;
  }
  console.log(`✓ Wired statusline collector in ${SETTINGS_JSON}`);
  if (result.preserved)
    console.log(`   (wrapped your existing statusline command)`);
  if (result.backup) console.log(`   (backup: ${result.backup})`);
  return true;
}

// --- main -------------------------------------------------------------------
function main() {
  const flags = new Set(process.argv.slice(2));
  const dryRun = flags.has("--dry-run");

  if (
    flags.has("--apply") ||
    flags.has("--apply-channel") ||
    flags.has("--apply-statusline") ||
    dryRun
  ) {
    const wantChannel =
      flags.has("--apply") || flags.has("--apply-channel") || dryRun;
    const wantStatusline =
      flags.has("--apply") || flags.has("--apply-statusline") || dryRun;
    let ok = true;
    if (wantChannel) ok = applyChannel(dryRun) && ok;
    if (wantStatusline) ok = applyStatuslinePiece(dryRun) && ok;
    console.log();
    if (!dryRun && ok && (wantChannel || wantStatusline)) {
      console.log("Done. Launch an opted-in session with:");
      console.log(
        `   bun ${resolve(import.meta.dir, "..", "..", "cockpit", "scripts", "monitor-up.ts")}`,
      );
    }
    process.exit(ok ? 0 : 1);
  }

  // default: check — dashboard prerequisites + cockpit channel
  const { requiredFailed } = printReport([
    ...dashboardChecks(),
    ...channelChecks(),
  ]);
  console.log();
  if (requiredFailed) {
    console.log("Required checks failed. Fix the issues above and rerun.");
    process.exit(1);
  }
  console.log("Required checks passed. To wire config, run:");
  console.log(`   bun ${import.meta.path} --apply        # both pieces`);
  console.log(
    `   bun ${import.meta.path} --dry-run      # preview without writing`,
  );
  process.exit(0);
}

if (import.meta.main) main();
