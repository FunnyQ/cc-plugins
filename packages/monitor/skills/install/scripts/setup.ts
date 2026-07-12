#!/usr/bin/env bun
//
// monitor:install engine — the single entry that checks every prerequisite for
// both skills and wires the configs a non-dev user otherwise edits by hand:
//   - the usage-dashboard statusline collector in ~/.claude/settings.json
//   - permissions.allow entries that pre-approve `bun <q-lab plugin script>.ts`
//     (so deeply-nested sub-agents — e.g. chronicle:drafter — can run them without
//     hitting an unanswerable permission prompt that silently denies them).
//
// The cockpit channel is now packaged in the plugin manifest (mcpServers +
// channels), so it no longer needs a hand-written ~/.claude.json entry. This
// engine only CLEANS UP a stale entry left by older versions — otherwise the
// channel would register twice once the packaged one loads.
//
// Checks reuse install.ts (dashboard) + the channel prerequisites here; the
// statusline write reuses setup-statusline.ts.
//
// Modes:
//   (default) / --check   read-only status report, exit 1 if a required check fails
//   --dry-run             print exactly what --apply would change, write nothing
//   --apply               wire the statusline + remove any stale channel entry
//   --apply-statusline    apply only the statusline collector wiring
//
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Check,
  dashboardChecks,
  pluginVersion,
  printReport,
} from "./install";
import { reapStaleMonitorProcesses } from "./reap-stale";
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
const COCKPIT_SCRIPTS = resolve(
  import.meta.dir,
  "..",
  "..",
  "cockpit",
  "scripts",
);
const COLLECTOR_SCRIPT = resolve(
  import.meta.dir,
  "..",
  "..",
  "usage-dashboard",
  "scripts",
  "statusline-collector.ts",
);
const COLLECTOR_COMMAND = `bun ${COLLECTOR_SCRIPT}`;
const CLAUDE_JSON = join(HOME, ".claude.json");
const SETTINGS_JSON = join(HOME, ".claude", "settings.json");
const MIN_CLAUDE_VERSION = "2.1.80"; // channels research-preview floor

// Pre-approve `bun <q-lab-marketplace plugin script>.ts` in permissions.allow.
// Without this, an un-allowlisted bun call hits a permission prompt — and a
// deeply-nested sub-agent (e.g. chronicle:editor → chronicle:drafter, or
// chronicle:manager → chronicle:analyst) can't surface that prompt to be answered,
// so it is silently DENIED and the whole flow stalls. Static allow entries make the
// scripts runnable at any nesting depth, no prompt. Mirrors the odin entry.
const SCRIPT_PERMISSIONS = [
  "Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts)",
  "Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts *)",
];

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

type ResolveDependency = (specifier: string, from: string) => string;

function defaultResolve(specifier: string, from: string): string {
  return Bun.resolveSync(specifier, from);
}

// A stale cockpit-channel entry in ~/.claude.json from an older version that
// hand-wired the channel, or null if there's none. The channel is plugin-
// packaged now, so any such entry should be removed to avoid double registration.
function channelConfiguredPath(): string | null {
  const { data } = readJson(CLAUDE_JSON);
  const args = data?.mcpServers?.["cockpit-channel"]?.args;
  if (!Array.isArray(args)) return null;
  return (
    args.find(
      (a) => typeof a === "string" && a.endsWith("cockpit-channel.ts"),
    ) ?? null
  );
}

// The collector script path currently referenced by statusLine.command, or null
// if the statusline isn't running a collector at all.
function statuslineReferencedCollector(): string | null {
  const { data } = readJson(SETTINGS_JSON);
  const cmd = data?.statusLine?.command;
  if (typeof cmd !== "string") return null;
  return cmd.match(/(\S*statusline-collector\.ts)/)?.[1] ?? null;
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
  // The channel is packaged in the plugin manifest now; a leftover hand-wired
  // entry would register it twice. Flag it for cleanup.
  add(
    "no stale cockpit-channel entry in ~/.claude.json",
    channelConfiguredPath() === null,
    "optional",
    `Found a hand-wired cockpit-channel in ~/.claude.json — the channel is plugin-packaged now.\n   Run: bun ${import.meta.path} --migrate to remove it.`,
  );
  return checks;
}

export function cockpitChecks(
  resolveDep: ResolveDependency = defaultResolve,
): Check[] {
  const checks: Check[] = [];
  const add = (
    label: string,
    ok: boolean,
    level: Check["level"],
    hint?: string,
  ) => checks.push({ label, ok, level, hint });

  let happyDomResolves = false;
  try {
    resolveDep("happy-dom", COCKPIT_SCRIPTS);
    happyDomResolves = true;
  } catch {
    happyDomResolves = false;
  }

  add(
    "mermaid diagram lint (happy-dom)",
    happyDomResolves,
    "optional",
    "Mermaid --diagram lint falls back to weaker heuristics that can pass source the dashboard cannot render.\n   Run bun install in the plugin directory, or let Bun auto-install it from ~/.bun/install/cache on first use (needs network once).",
  );

  return checks;
}

// --- cleanup: remove a stale hand-wired cockpit-channel from ~/.claude.json --
// Older versions wrote the channel here; it's plugin-packaged now, so a leftover
// entry would register the channel twice. "removed" when it deleted one, "none"
// when there was nothing to do, "error" when the file couldn't be parsed.
function unwireChannel(dryRun: boolean): "removed" | "none" | "error" {
  const { data, readable } = readJson(CLAUDE_JSON);
  if (!readable) {
    console.log(`✗ Couldn't parse ${CLAUDE_JSON} — fix it first.`);
    return "error";
  }
  const args = data?.mcpServers?.["cockpit-channel"]?.args;
  const hasEntry =
    Array.isArray(args) &&
    args.some((a) => typeof a === "string" && a.endsWith("cockpit-channel.ts"));
  if (!hasEntry) return "none";
  if (dryRun) {
    console.log(
      `Would remove the stale cockpit-channel entry from ${CLAUDE_JSON}.`,
    );
    return "removed";
  }
  const next = { ...data, mcpServers: { ...(data.mcpServers ?? {}) } };
  delete next.mcpServers["cockpit-channel"];
  const bak = backup(CLAUDE_JSON);
  writeFileSync(CLAUDE_JSON, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`✓ Removed stale cockpit-channel from ${CLAUDE_JSON}`);
  if (bak) console.log(`   (backup: ${bak})`);
  return "removed";
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

// --- apply: pre-approve q-lab plugin scripts in permissions.allow -----------
function missingScriptPermissions(): string[] {
  const { data } = readJson(SETTINGS_JSON);
  const allow: unknown = data?.permissions?.allow;
  const have = Array.isArray(allow) ? (allow as string[]) : [];
  return SCRIPT_PERMISSIONS.filter((p) => !have.includes(p));
}

function applyScriptPermissions(dryRun: boolean): boolean {
  const { data, readable } = readJson(SETTINGS_JSON);
  if (!readable) {
    console.log(`✗ Couldn't parse ${SETTINGS_JSON} — fix it first.`);
    return false;
  }
  const missing = missingScriptPermissions();
  if (missing.length === 0) {
    console.log("○ q-lab plugin scripts already pre-approved — nothing to do.");
    return true;
  }
  if (dryRun) {
    console.log(`Would add to permissions.allow in ${SETTINGS_JSON}:`);
    for (const p of missing) console.log(`   ${p}`);
    return true;
  }
  const allow = Array.isArray(data.permissions?.allow)
    ? (data.permissions.allow as string[])
    : [];
  const next = {
    ...data,
    permissions: { ...(data.permissions ?? {}), allow: [...allow, ...missing] },
  };
  const bak = backup(SETTINGS_JSON);
  writeFileSync(SETTINGS_JSON, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`✓ Pre-approved q-lab plugin scripts in ${SETTINGS_JSON}`);
  if (bak) console.log(`   (backup: ${bak})`);
  return true;
}

function scriptPermissionChecks(): Check[] {
  const missing = missingScriptPermissions();
  return [
    {
      label: "q-lab plugin scripts pre-approved (bun)",
      ok: missing.length === 0,
      level: "optional",
      hint: "Without these allow entries, `bun <plugin script>` prompts for permission — and a nested sub-agent (e.g. chronicle:drafter) can't answer it, so it's silently denied.\n   Run --apply to add them.",
    },
  ];
}

// --- migrate: re-point drifted pieces + clean up the stale channel entry ----
// Never fresh-wires the statusline — that's the initial opt-in, which stays
// manual. It only re-points an already-wired statusline that drifted to an older
// plugin-cache path, and removes a stale hand-wired channel entry (now packaged).
function migrate(): string[] {
  const changed: string[] = [];

  if (unwireChannel(false) === "removed") {
    changed.push("cockpit-channel cleanup");
  }

  const sl = statuslineReferencedCollector();
  if (sl && sl !== COLLECTOR_SCRIPT && applyStatuslinePiece(false)) {
    changed.push("statusline collector");
  }

  return changed;
}

// --- session-check: marker-gated migrate for the SessionStart hook ----------
// Runs at most once per plugin version: compares the current version against a
// marker in $CLAUDE_PLUGIN_DATA and only migrates when it changed (or on first
// run). Keeps per-session cost to a fast string compare after the first launch.
function sessionCheck(): void {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const version = pluginVersion();
  // No data dir or unknown version → can't gate safely; do nothing.
  if (!dataDir || !version) return;

  const marker = join(dataDir, ".wired-version");
  let last: string | null = null;
  try {
    if (existsSync(marker)) last = readFileSync(marker, "utf-8").trim();
  } catch {
    last = null;
  }
  if (last === version) return; // already reconciled for this version

  // The version just changed (or this is a first run) — exactly when daemons from the
  // previous version are still running. Before 3.19.0 the channel had no exit path, so
  // those are immortal; retire them now. Only true orphans (PPID 1) are touched.
  const reaped = reapStaleMonitorProcesses(version);
  if (reaped) {
    console.log(
      `monitor: retired ${reaped} leftover process${reaped === 1 ? "" : "es"} from a previous version.`,
    );
  }

  const changed = migrate();
  if (changed.length) {
    console.log(
      `monitor: updated ${changed.join(" + ")} to v${version} after a plugin update.`,
    );
  } else if (!statuslineReferencedCollector()) {
    // Nothing wired yet (fresh install). One gentle, write-free nudge per
    // version — the marker below keeps it from repeating every session.
    console.log(
      "monitor: not set up yet — run the /monitor:install skill to enable the cockpit send box and live usage limits.",
    );
  }
  try {
    writeFileSync(marker, `${version}\n`);
  } catch {
    // Best-effort marker; if the data dir isn't writable we just retry next session.
  }
}

// --- main -------------------------------------------------------------------
function main() {
  const flags = new Set(process.argv.slice(2));
  const dryRun = flags.has("--dry-run");

  // SessionStart hook entry — quiet, marker-gated, never fresh-wires.
  if (flags.has("--session-check")) {
    sessionCheck();
    process.exit(0);
  }

  // Re-point drifted pieces now (no version gate); used manually too.
  if (flags.has("--migrate")) {
    const changed = migrate();
    console.log(
      changed.length
        ? `Re-pointed: ${changed.join(" + ")} → current version.`
        : "Nothing to migrate — configured paths are current.",
    );
    process.exit(0);
  }

  if (flags.has("--apply") || flags.has("--apply-statusline") || dryRun) {
    const wantStatusline =
      flags.has("--apply") || flags.has("--apply-statusline") || dryRun;
    let ok = true;
    // --apply / --dry-run also clean up a stale hand-wired channel entry and
    // pre-approve the q-lab plugin scripts.
    if (flags.has("--apply") || dryRun) {
      ok = unwireChannel(dryRun) !== "error" && ok;
      ok = applyScriptPermissions(dryRun) && ok;
    }
    if (wantStatusline) ok = applyStatuslinePiece(dryRun) && ok;
    console.log();
    if (!dryRun && ok && wantStatusline) {
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
    ...cockpitChecks(),
    ...scriptPermissionChecks(),
  ]);
  console.log();
  if (requiredFailed) {
    console.log("Required checks failed. Fix the issues above and rerun.");
    process.exit(1);
  }
  console.log("Required checks passed. To wire config, run:");
  console.log(
    `   bun ${import.meta.path} --apply        # statusline + cleanup`,
  );
  console.log(
    `   bun ${import.meta.path} --dry-run      # preview without writing`,
  );
  process.exit(0);
}

if (import.meta.main) main();
