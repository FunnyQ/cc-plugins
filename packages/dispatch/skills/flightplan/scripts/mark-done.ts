#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import {
  GATE_SECTIONS,
  TASK_STATUSES,
  matchStatusLine,
  parseStatusValue,
} from "./lib/parse-task";

const GATE_HEADINGS = new Set<string>(
  GATE_SECTIONS.map((s) => s.toLowerCase()),
);

export function markDone(content: string): string {
  const lines = content.split("\n");

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
