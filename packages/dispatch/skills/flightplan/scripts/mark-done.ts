#!/usr/bin/env bun
/**
 * Finalize a passed task: flip its `> **Status**:` to `done` and tick every
 * checkbox in the `## Acceptance criteria` and `## Verification` sections.
 *
 * autopilot's binary gate is all-or-nothing — a task only advances once every
 * acceptance criterion and verification step holds — so when a task passes,
 * all of those boxes are passed and get checked here in one deterministic step
 * (an LLM hand-edit would too easily miss one or reformat the file).
 *
 * Boxes in any other section (Implementation notes, Out of scope, …) are left
 * untouched — only the two gate sections represent "did it pass".
 *
 * Usage:
 *   bun mark-done.ts <task-file>
 */
import { readFile, writeFile } from "node:fs/promises";

/** Sections whose checkboxes represent the pass/fail gate. Lowercased. */
const GATE_SECTIONS = new Set(["acceptance criteria", "verification"]);

/**
 * Set Status to `done` and tick the gate-section checkboxes. Pure — returns the
 * new file content. Idempotent.
 */
export function markDone(content: string): string {
  const lines = content.split("\n");
  let inGateSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Section boundary: track whether we're inside a gate section.
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inGateSection = GATE_SECTIONS.has(heading[1].trim().toLowerCase());
      continue;
    }

    // Status line lives in the header blockquote (before any `##`).
    const status = /^(>\s*\*\*Status\*\*\s*:\s*)([A-Za-z-]+)\s*$/.exec(line);
    if (status) {
      lines[i] = `${status[1]}done`;
      continue;
    }

    // Tick unchecked boxes only inside a gate section.
    if (inGateSection) {
      lines[i] = line.replace(/^(\s*[-*]\s+)\[ \]/, "$1[x]");
    }
  }

  return lines.join("\n");
}

async function main() {
  const taskFile = process.argv[2];
  if (!taskFile) {
    console.error("Usage: bun mark-done.ts <task-file>");
    process.exit(2);
  }
  const content = await readFile(taskFile, "utf-8");
  await writeFile(taskFile, markDone(content));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("mark-done error:", err.message);
    process.exit(2);
  });
}
