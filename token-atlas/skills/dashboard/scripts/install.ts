#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Level = "required" | "optional";
type Check = { label: string; ok: boolean; level: Level; hint?: string };

const HOME = homedir();
const checks: Check[] = [];

function check(label: string, ok: boolean, level: Level, hint?: string) {
  checks.push({ label, ok, level, hint });
}

// Bun
check(
  "bun runtime",
  typeof Bun !== "undefined" && !!Bun.version,
  "required",
  "Install bun: https://bun.sh",
);

// stats-cache
const statsCache = join(HOME, ".claude", "stats-cache.json");
check(
  `stats-cache.json (${statsCache})`,
  existsSync(statsCache),
  "required",
  "File created by Claude Code on first /stats run; open Claude Code at least once.",
);

// history — optional: project ranking just stays empty without it
const history = join(HOME, ".claude", "history.jsonl");
check(
  `history.jsonl (${history})`,
  existsSync(history),
  "optional",
  "Project ranking will be empty without it.",
);

// Vendor files
const vendor = join(import.meta.dir, "..", "dashboard", "dist", "vendor");
check(
  `petite-vue (${vendor}/petite-vue.es.js)`,
  existsSync(join(vendor, "petite-vue.es.js")),
  "required",
);
check(
  `chart.js (${vendor}/chart.umd.js)`,
  existsSync(join(vendor, "chart.umd.js")),
  "required",
);

// Pricing defaults
const pricing = join(
  import.meta.dir,
  "..",
  "references",
  "pricing-defaults.json",
);
check(`pricing defaults (${pricing})`, existsSync(pricing), "required");

// Live usage limits — optional: dashboard works without it, the usage-window
// panel just stays empty until Claude Code's statusline feeds rate_limits in.
const settingsPath = join(HOME, ".claude", "settings.json");
const collectorCommand = `bun ${join(import.meta.dir, "statusline-collector.ts")}`;
let statuslineCommand: string | null = null;
let settingsReadable = true;
try {
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const cmd = settings?.statusLine?.command;
    if (typeof cmd === "string") statuslineCommand = cmd;
  }
} catch {
  settingsReadable = false;
}
// Installed plugins live at version-pinned cache paths, so a configured path
// can go stale after `claude plugin update`. Treat it as wired only if the
// referenced collector file still exists; otherwise re-suggest the live path.
const referencedCollector =
  statuslineCommand?.match(/(\S*statusline-collector\.ts)/)?.[1] ?? null;
const collectorWired = referencedCollector
  ? existsSync(referencedCollector)
  : false;

let usageHint: string | undefined;
if (!settingsReadable) {
  usageHint = `Couldn't parse ${settingsPath} — fix it, then add a statusLine command running: ${collectorCommand}`;
} else if (referencedCollector) {
  // Path points at a collector that no longer exists (older plugin version).
  usageHint =
    `statusLine points at a collector path that no longer exists (likely an older plugin version).\n` +
    `   Update statusLine.command in ${settingsPath} to: ${collectorCommand}`;
} else if (statuslineCommand) {
  // A statusline is already set — wrap it so the user's line keeps rendering.
  usageHint =
    `statusLine is set but doesn't run the collector, so live rate_limits aren't captured.\n` +
    `   Wrap your current line — set statusLine.command in ${settingsPath} to:\n` +
    `   "TOKEN_ATLAS_STATUSLINE_COMMAND='${statuslineCommand}' ${collectorCommand}"`;
} else {
  usageHint =
    `No statusLine configured. Add to ${settingsPath} to capture live usage limits:\n` +
    `   "statusLine": { "type": "command", "command": "${collectorCommand}", "padding": 0 }\n` +
    `   Forwards to "bunx -y ccstatusline@latest" by default (override via TOKEN_ATLAS_STATUSLINE_COMMAND).`;
}
check(
  "live usage limits (statusline collector)",
  collectorWired,
  "optional",
  usageHint,
);

let requiredFailed = false;
let optionalFailed = false;
for (const c of checks) {
  const mark = c.ok ? "✓" : c.level === "required" ? "✗" : "○";
  console.log(`${mark} ${c.label}`);
  if (!c.ok) {
    if (c.level === "required") requiredFailed = true;
    else optionalFailed = true;
    if (c.hint) console.log(`   → ${c.hint}`);
  }
}

console.log();
if (requiredFailed) {
  console.log("Required checks failed. Fix the issues above and rerun.");
  process.exit(1);
}
if (optionalFailed) {
  console.log(
    "All required checks passed (some optional data missing — dashboard will still launch).",
  );
} else {
  console.log("All checks passed. Run: bun run scripts/atlas-server.ts");
}
process.exit(0);
