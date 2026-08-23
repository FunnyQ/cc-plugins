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
 * This is ONE state transition: Status and gate checkboxes move together, or
 * nothing moves. `markDone()` validates the header before it rewrites anything,
 * so a malformed task can never come back with ticked boxes and a stale Status.
 * That pairing is the whole point — a half-applied transition reads downstream
 * as "done but unverified", which is exactly the state readiness must reject.
 *
 * Usage:
 *   bun mark-done.ts <task-file>
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  GATE_SECTIONS,
  TASK_STATUSES,
  matchStatusLine,
  parseStatusValue,
} from "./lib/parse-task";

// Lowercased from the same list `uncheckedGateItems` reads, so the writer here
// and the `taskValidity` check downstream can never disagree about which
// sections are the gate.
const GATE_HEADINGS = new Set<string>(
  GATE_SECTIONS.map((s) => s.toLowerCase()),
);

/**
 * Set Status to `done` and tick the gate-section checkboxes. Pure — returns the
 * new file content. Idempotent.
 *
 * Throws when the header Status is missing, duplicated, or not one of the four
 * bare values. Throwing before any rewrite is deliberate: the caller must never
 * receive partially-transitioned content.
 */
export function markDone(content: string): string {
  const lines = content.split("\n");

  // Header scope: everything before the first `##` section heading. A Status
  // line quoted in the body (a template, an example) is not a second header.
  const firstSection = lines.findIndex((l) => /^##\s+/.test(l));
  const headerEnd = firstSection === -1 ? lines.length : firstSection;

  const statusLines: number[] = [];
  for (let i = 0; i < headerEnd; i++) {
    if (matchStatusLine(lines[i])) statusLines.push(i);
  }

  if (statusLines.length === 0) {
    throw new Error(
      "no `> **Status**:` line in the header blockquote (before the first `##` heading)",
    );
  }
  if (statusLines.length > 1) {
    const at = statusLines.map((i) => i + 1).join(", ");
    throw new Error(
      `${statusLines.length} \`> **Status**:\` lines in the header (lines ${at}) — a task must carry exactly one`,
    );
  }

  const statusIndex = statusLines[0];
  const status = matchStatusLine(lines[statusIndex])!;
  if (parseStatusValue(status.raw) === null) {
    throw new Error(
      `Status value "${status.raw.trim()}" on line ${statusIndex + 1} is not one of ${TASK_STATUSES.join(" / ")} — write the value bare and put run notes on their own line`,
    );
  }

  // Validation passed. Only now does anything get rewritten.
  const out = [...lines];
  out[statusIndex] = `${status.prefix}done`;

  let inGateSection = false;
  for (let i = headerEnd; i < out.length; i++) {
    const heading = /^##\s+(.+?)\s*$/.exec(out[i]);
    if (heading) {
      inGateSection = GATE_HEADINGS.has(heading[1].trim().toLowerCase());
      continue;
    }
    if (inGateSection) {
      out[i] = out[i].replace(/^(\s*[-*]\s+)\[ \]/, "$1[x]");
    }
  }

  return out.join("\n");
}

async function main() {
  const taskFile = process.argv[2];
  if (!taskFile) {
    console.error("Usage: bun mark-done.ts <task-file>");
    process.exit(2);
  }
  const content = await readFile(taskFile, "utf-8");
  // markDone throws before producing content, so a failure leaves the file
  // byte-for-byte unchanged.
  await writeFile(taskFile, markDone(content));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `mark-done error: ${process.argv[2] ?? "<no file>"}: ${err.message}`,
    );
    process.exit(2);
  });
}
