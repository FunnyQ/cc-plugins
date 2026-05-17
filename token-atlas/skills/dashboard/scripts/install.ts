#!/usr/bin/env bun
import { existsSync } from "node:fs";
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
  console.log("All checks passed. Run: bun run scripts/serve-dashboard.ts");
}
process.exit(0);
