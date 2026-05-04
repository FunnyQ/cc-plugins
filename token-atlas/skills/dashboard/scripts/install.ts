#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const checks: Array<{ label: string; ok: boolean; hint?: string }> = [];

function check(label: string, ok: boolean, hint?: string) {
  checks.push({ label, ok, hint });
}

// Bun
check(
  "bun runtime",
  typeof Bun !== "undefined" && !!Bun.version,
  "Install bun: https://bun.sh",
);

// stats-cache
const statsCache = join(HOME, ".claude", "stats-cache.json");
check(
  `stats-cache.json (${statsCache})`,
  existsSync(statsCache),
  "File created by Claude Code on first /stats run; open Claude Code at least once.",
);

// history
const history = join(HOME, ".claude", "history.jsonl");
check(
  `history.jsonl (${history})`,
  existsSync(history),
  "Optional — project ranking will be empty without it.",
);

// Vendor files
const vendor = join(import.meta.dir, "..", "dashboard", "dist", "vendor");
check(
  `petite-vue (${vendor}/petite-vue.es.js)`,
  existsSync(join(vendor, "petite-vue.es.js")),
);
check(
  `chart.js (${vendor}/chart.umd.js)`,
  existsSync(join(vendor, "chart.umd.js")),
);

// Pricing defaults
const pricing = join(
  import.meta.dir,
  "..",
  "references",
  "pricing-defaults.json",
);
check(`pricing defaults (${pricing})`, existsSync(pricing));

let allOk = true;
for (const c of checks) {
  const mark = c.ok ? "✓" : "✗";
  console.log(`${mark} ${c.label}`);
  if (!c.ok) {
    allOk = false;
    if (c.hint) console.log(`   → ${c.hint}`);
  }
}

console.log();
if (allOk) {
  console.log("All checks passed. Run: bun run scripts/serve-dashboard.ts");
  process.exit(0);
} else {
  console.log("Some checks failed. Fix the issues above and rerun.");
  process.exit(1);
}
