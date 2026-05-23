#!/usr/bin/env bun
// Find the current Claude Code session uuid for a project.
//
// Claude Code stores each session's transcript at
//   ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
// where the project path is encoded by replacing "/" and "." with "-".
// The *current* session is the most-recently-modified transcript in that dir —
// and because invoking this script writes a tool-use line into the live
// transcript, that file is reliably the newest at the moment we look.
//
// Prints the uuid to stdout (exit 0), or a message to stderr (exit 1) when no
// transcript is found — in which case the caller should generate a fresh uuid.
//
// Usage: bun find-session.ts [projectPath]   (defaults to cwd)
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const project = process.argv[2] || process.cwd();
const encoded = project.replace(/[/.]/g, "-");
const dir = join(homedir(), ".claude", "projects", encoded);

if (!existsSync(dir)) {
  console.error(
    `find-session: no transcript dir for ${project}\n  (looked in ${dir})`,
  );
  process.exit(1);
}

let newest: { id: string; mtime: number } | null = null;
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".jsonl")) continue;
  const mtime = statSync(join(dir, name)).mtimeMs;
  const id = name.slice(0, -".jsonl".length);
  if (!newest || mtime > newest.mtime) newest = { id, mtime };
}

if (!newest) {
  console.error(`find-session: no .jsonl transcripts in ${dir}`);
  process.exit(1);
}

console.log(newest.id);
