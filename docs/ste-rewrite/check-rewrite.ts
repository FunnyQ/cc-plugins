#!/usr/bin/env bun
/**
 * check-rewrite.ts — mechanical gate for the STE-lite rewrite.
 *
 * Compares each changed markdown file against its committed version and enforces
 * the parts of STE-RULES.md Section 3 and Section 4 that a machine can check.
 *
 *   bun docs/ste-rewrite/check-rewrite.ts                  # every changed .md vs HEAD
 *   bun docs/ste-rewrite/check-rewrite.ts packages/relay   # limit to a path prefix
 *
 * Checks per file:
 *   1. frontmatter byte-identical          (§3.1 — the trigger surface)
 *   2. fenced code blocks byte-identical   (§3.2)
 *   3. heading count and levels unchanged  (§3.4 — text may change, structure may not)
 *   4. word count within 115%              (§R13)
 *   5. instruction sentences over 20 words (§R3 — reported, not failed)
 *
 * Exit 0 = checks 1-4 pass. Exit 1 = at least one hard check failed.
 */

import { relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const argv = process.argv.slice(2);
const show = argv.includes("--show");
const prefix = argv.find((a) => !a.startsWith("--")) ?? "";

function sh(cmd: string): string {
  return Bun.spawnSync(["bash", "-lc", cmd], { cwd: ROOT }).stdout.toString();
}

const changed = sh(`git diff --name-only HEAD -- '*.md'`)
  .trim()
  .split("\n")
  .filter((f) => f && f.startsWith(prefix));

if (changed.length === 0) {
  console.log("no changed markdown files vs HEAD");
  process.exit(0);
}

type Parts = {
  frontmatter: string;
  fences: string[];
  headings: { level: number; text: string }[];
  words: number;
  longSentences: string[];
  wrappedSpans: string[];
};

function parse(body: string): Parts {
  const lines = body.split("\n");

  // frontmatter — only when the very first line opens it
  let frontmatter = "";
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      frontmatter = lines.slice(0, end + 1).join("\n");
      i = end + 1;
    }
  }

  const fences: string[] = [];
  const headings: Parts["headings"] = [];
  const prose: string[] = [];
  let fenced = false;
  let current: string[] = [];

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      current.push(line);
      if (fenced) {
        fences.push(current.join("\n"));
        current = [];
      }
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      current.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      headings.push({ level: h[1].length, text: h[2] });
      continue;
    }
    prose.push(line);
  }
  if (current.length) fences.push(current.join("\n")); // unterminated fence

  const words = prose.join(" ").split(/\s+/).filter(Boolean).length;

  // Sentence length (§R3). Prose in this repo is hard-wrapped, so consecutive
  // lines must be re-joined before splitting. But a table row or a new list item
  // is its own unit — joining those produced huge phantom "sentences".
  const isBreak = (l: string) =>
    l.trim() === "" || /^\s*\|/.test(l) || /^\s*([-*+]|\d+\.)\s/.test(l);

  const units: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) units.push(buf.join(" "));
    buf = [];
  };
  for (const line of prose) {
    if (isBreak(line)) {
      flush();
      if (/^\s*\|/.test(line)) continue; // table rows are data, not prose
      buf.push(line.replace(/^\s*([-*+]|\d+\.)\s/, ""));
      continue;
    }
    buf.push(line);
  }
  flush();

  // Inline code collapses to one token — a long path is not a long sentence.
  const longSentences = units
    .flatMap((u) => u.replace(/`[^`]*`/g, "CODE").split(/(?<=[.!?:])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter(Boolean).length > 20);

  // Inline code spans broken across a line wrap (§3.3). The rendered page looks
  // fine, but the RAW markdown an agent reads now holds a newline plus indent
  // inside the token — a shell command copied out of it gets a different argv.
  // Rewrapping a paragraph is the normal way this gets introduced.
  const wrappedSpans: string[] = [];
  {
    let fenced2 = false;
    const kept: string[] = [];
    for (const l of lines) {
      if (/^\s*```/.test(l)) {
        fenced2 = !fenced2;
        kept.push("");
        continue;
      }
      kept.push(fenced2 ? "" : l);
    }
    const text = kept.join("\n");
    for (const m of text.matchAll(/`([^`]*)`/g)) {
      if (m[1].includes("\n")) wrappedSpans.push(m[1].replace(/\n\s*/g, " ⏎ "));
    }
  }

  return { frontmatter, fences, headings, words, longSentences, wrappedSpans };
}

let failed = 0;

for (const file of changed) {
  const before = parse(sh(`git show HEAD:'${file}'`));
  const after = parse(await Bun.file(`${ROOT}/${file}`).text());
  const problems: string[] = [];
  const notes: string[] = [];

  if (before.frontmatter !== after.frontmatter) {
    problems.push("frontmatter CHANGED — this is the trigger surface (§3.1)");
  }

  if (before.fences.length !== after.fences.length) {
    problems.push(
      `fenced block count ${before.fences.length} → ${after.fences.length} (§3.2)`,
    );
  } else {
    before.fences.forEach((f, n) => {
      if (f !== after.fences[n])
        problems.push(`fenced block #${n + 1} modified (§3.2)`);
    });
  }

  if (before.headings.length !== after.headings.length) {
    problems.push(
      `heading count ${before.headings.length} → ${after.headings.length} (§3.4)`,
    );
  } else {
    before.headings.forEach((h, n) => {
      const b = after.headings[n];
      if (h.level !== b.level) {
        problems.push(
          `heading #${n + 1} level h${h.level} → h${b.level} (§3.4)`,
        );
      } else if (h.text !== b.text) {
        notes.push(`reworded: "${h.text}" → "${b.text}"`);
      }
    });
  }

  const ratio = before.words === 0 ? 1 : after.words / before.words;
  // §R13 — telegraphic files must grow: R2/R10 turn clipped notes into full
  // sentences with articles. A file with no long-sentence problem and little
  // prose gets the wider budget.
  const telegraphic = before.longSentences.length < 3 && before.words < 500;
  const cap = telegraphic ? 1.35 : 1.15;
  if (ratio > cap) {
    problems.push(
      `words ${before.words} → ${after.words} ` +
        `(${Math.round(ratio * 100)}% > ${Math.round(cap * 100)}%, §R13)`,
    );
  } else if (telegraphic && ratio > 1.15) {
    notes.push(`telegraphic-file budget applied (cap 135%, §R13 exception)`);
  }

  if (after.wrappedSpans.length > before.wrappedSpans.length) {
    const fresh = after.wrappedSpans.filter(
      (s) => !before.wrappedSpans.includes(s),
    );
    problems.push(
      `inline code span broken across a line wrap (§3.3): ` +
        (fresh.length
          ? fresh.map((s) => `\`${s}\``).join(", ")
          : "count went up"),
    );
  }

  const longDelta = after.longSentences.length - before.longSentences.length;
  notes.push(
    `sentences >20 words: ${before.longSentences.length} → ${after.longSentences.length}` +
      (longDelta > 0 ? "  ⚠️ went UP" : ""),
  );
  if (show) {
    for (const s of after.longSentences) {
      notes.push(`  >20 [${s.split(/\s+/).length}] ${s.slice(0, 120)}`);
    }
  }

  const mark = problems.length ? "❌" : "✅";
  console.log(
    `\n${mark} ${relative("", file)}   ${before.words} → ${after.words} words ` +
      `(${Math.round(ratio * 100)}%)`,
  );
  for (const p of problems) console.log(`     FAIL  ${p}`);
  for (const n of notes) console.log(`     note  ${n}`);
  if (problems.length) failed++;
}

console.log(
  `\n${changed.length} file(s) checked, ${failed} failed.` +
    (failed ? "" : "  Run check-anchors.ts next."),
);
process.exit(failed ? 1 : 0);
