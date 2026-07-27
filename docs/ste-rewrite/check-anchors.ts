#!/usr/bin/env bun
/**
 * check-anchors.ts — verify every in-repo markdown anchor link still resolves.
 *
 * Run this before and after the STE rewrite. A heading reword that breaks a
 * `](#anchor)` or `](other.md#anchor)` link shows up here.
 *
 *   bun docs/ste-rewrite/check-anchors.ts            # scope = the 56 instruction files
 *   bun docs/ste-rewrite/check-anchors.ts --all      # scope = every tracked .md
 *
 * Exit 0 = all links resolve. Exit 1 = at least one broken link.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const all = process.argv.includes("--all");

function sh(cmd: string): string {
  return Bun.spawnSync(["bash", "-lc", cmd], { cwd: ROOT }).stdout.toString();
}

const files = all
  ? sh(`git ls-files '*.md' | grep -v node_modules`).trim().split("\n")
  : sh(
      `find packages \\( -name 'SKILL.md' -o -path '*/references/*.md' ` +
        `-o -path '*/agents/*.md' -o -path '*/commands/*.md' \\) -not -path '*/dist/*'`,
    )
      .trim()
      .split("\n");

/** GitHub-flavoured heading slug. */
function slugify(heading: string): string {
  return heading
    .replace(/`/g, "")
    .replace(/\*\*?/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/** Headings outside fenced code blocks. */
function slugsOf(path: string): Set<string> {
  const out = new Set<string>();
  let fenced = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const base = slugify(m[2]);
    // GitHub disambiguates duplicates with -1, -2, …
    let slug = base,
      n = 0;
    while (out.has(slug)) slug = `${base}-${++n}`;
    out.add(slug);
  }
  return out;
}

const slugCache = new Map<string, Set<string>>();
function slugsFor(abs: string): Set<string> {
  if (!slugCache.has(abs)) {
    try {
      slugCache.set(abs, slugsOf(abs));
    } catch {
      slugCache.set(abs, new Set());
    }
  }
  return slugCache.get(abs)!;
}

let checked = 0;
const broken: string[] = [];

for (const rel of files) {
  if (!rel) continue;
  const abs = resolve(ROOT, rel);
  let body: string;
  try {
    body = readFileSync(abs, "utf8");
  } catch {
    continue;
  }

  let fenced = false;
  body.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of line.matchAll(/\]\(([^)\s]*)#([^)\s]+)\)/g)) {
      const [, target, anchor] = m;
      if (/^https?:/.test(target)) continue; // external URL — not ours
      checked++;
      const targetAbs = target ? resolve(dirname(abs), target) : abs;
      if (!slugsFor(targetAbs).has(anchor.toLowerCase())) {
        broken.push(
          `${relative(ROOT, abs)}:${i + 1}  →  ${target || "(same file)"}#${anchor}`,
        );
      }
    }
  });
}

console.log(`scope: ${files.length} files`);
console.log(`in-repo anchor links checked: ${checked}`);
if (broken.length === 0) {
  console.log("✅ all anchors resolve");
  process.exit(0);
}
console.log(`❌ ${broken.length} broken:`);
for (const b of broken) console.log(`   ${b}`);
process.exit(1);
