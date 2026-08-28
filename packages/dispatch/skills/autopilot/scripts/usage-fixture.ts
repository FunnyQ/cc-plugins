#!/usr/bin/env bun
/**
 * Build a complete, self-contained transcript scenario in a temp directory and print
 * one JSON object describing it. A dev tool only: no runtime code imports this, and
 * it takes no part in serving the dashboard. See ../_context/shared.md for the
 * contract every manual/browser gate in this plan relies on.
 *
 *   bun usage-fixture.ts [--out <dir>]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectSlug } from "./usage-source";
import type { TokenCounts } from "./usage-types";

type NoteEntry = {
  kind: "note";
  ts: string;
  task: string;
  role: string;
  attempt?: number;
  agentLabel?: string;
  phase?: "start" | "end";
  message: string;
};

function writeJsonl(path: string, lines: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

/** The announce-line shape from ../_context/data-model.md, embedding `runLog` (which
 * embeds `planDir`) so discovery's plan-membership check finds it in the first line. */
function announcePrompt(
  runLog: string,
  task: string,
  role: string,
  attempt: number,
): string {
  return (
    `First, announce yourself: bun scripts/flightlog.ts log ${runLog} ` +
    `--task ${task} --role ${role} --attempt ${attempt} --agent "<your label>" --phase start\n` +
    `Then proceed.`
  );
}

function assistantLine(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  },
): object {
  return { type: "assistant", message: { model, usage } };
}

function userLine(content: string, timestamp: string): object {
  return { type: "user", timestamp, message: { role: "user", content } };
}

function noteEntry(
  task: string,
  role: string,
  attempt: number,
  agentLabel: string,
  phase: "start" | "end",
  ts: string,
  message: string,
): NoteEntry {
  return { kind: "note", ts, task, role, attempt, agentLabel, phase, message };
}

export function buildFixture(root: string): {
  planDir: string;
  projectsRoot: string;
  expected: {
    totals: TokenCounts;
    byTask: Record<string, TokenCounts>;
    agentCount: number;
    rowsWithoutUsage: number;
  };
} {
  mkdirSync(root, { recursive: true });

  // A plain marker file — a git worktree's `.git` is a regular file too, so
  // `repoRootOf` must find this by existence, not by insisting on a directory.
  writeFileSync(join(root, ".git"), "gitdir: fixture\n");

  const planDir = join(root, "plan");
  mkdirSync(join(planDir, "tasks"), { recursive: true });
  const runLog = join(planDir, ".flightlog", "run.jsonl");

  const slug = projectSlug(root);
  const projectsRoot = join(root, "projects");
  const sessionDir = join(projectsRoot, slug, "session-1");
  const wfDir = join(sessionDir, "subagents", "workflows", "wf_fixture");

  // Two agents leave a transcript; a third logs to the flightlog but never gets one —
  // the only way a later gate can prove "unavailable" renders differently from zero.
  const devFile = join(wfDir, "agent-dev.jsonl");
  const reviewFile = join(wfDir, "agent-review.jsonl");

  writeJsonl(devFile, [
    userLine(
      announcePrompt(runLog, "work/01", "dev", 1),
      "2026-01-01T00:00:00.000Z",
    ),
    assistantLine("claude-haiku-4-5-20251001", {
      input_tokens: 100,
      output_tokens: 1000,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 1000,
    }),
  ]);

  writeJsonl(reviewFile, [
    userLine(
      announcePrompt(runLog, "work/01", "review", 1),
      "2026-01-01T00:05:00.000Z",
    ),
    assistantLine("claude-opus-5", {
      input_tokens: 200,
      output_tokens: 2000,
      cache_read_input_tokens: 20000,
      cache_creation_input_tokens: 2000,
    }),
  ]);

  writeJsonl(runLog, [
    noteEntry(
      "work/01",
      "dev",
      1,
      "fixture-dev",
      "start",
      "2026-01-01T00:00:00.000Z",
      "starting",
    ),
    noteEntry(
      "work/01",
      "dev",
      1,
      "fixture-dev",
      "end",
      "2026-01-01T00:02:00.000Z",
      "done",
    ),
    noteEntry(
      "work/01",
      "review",
      1,
      "fixture-review",
      "start",
      "2026-01-01T00:05:00.000Z",
      "starting",
    ),
    noteEntry(
      "work/01",
      "review",
      1,
      "fixture-review",
      "end",
      "2026-01-01T00:07:00.000Z",
      "done",
    ),
    // The third agent: a flightlog row with no matching transcript on disk.
    noteEntry(
      "work/01",
      "verify",
      1,
      "fixture-verify",
      "start",
      "2026-01-01T00:10:00.000Z",
      "starting",
    ),
    noteEntry(
      "work/01",
      "verify",
      1,
      "fixture-verify",
      "end",
      "2026-01-01T00:11:00.000Z",
      "done",
    ),
  ]);

  const totals: TokenCounts = {
    input: 300,
    output: 3000,
    cacheRead: 30000,
    cacheWrite: 3000,
  };

  return {
    planDir,
    projectsRoot,
    expected: {
      totals,
      byTask: { "work/01": totals },
      agentCount: 2,
      rowsWithoutUsage: 1,
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out =
    outIndex !== -1 && args[outIndex + 1]
      ? args[outIndex + 1]!
      : mkdtempSync(join(tmpdir(), "usage-fixture-"));

  console.log(JSON.stringify(buildFixture(out)));
}
