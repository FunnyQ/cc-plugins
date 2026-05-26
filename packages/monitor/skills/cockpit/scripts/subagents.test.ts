// Tests for the pure sidechain done-detection (subagent liveness).
// Shapes mirror real ~/.claude sidechain transcripts: a final assistant turn
// stops on "end_turn" OR null depending on version, followed by SubagentStop
// hook_progress entries when that hook is configured.
// Run: bun test packages/monitor/skills/cockpit/scripts/subagents.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  codexRolloutIsDone,
  sidechainIsDone,
  subagentCountForCodex,
} from "./subagents";

// An assistant turn line. `content` defaults to a plain text answer (no tool).
function assistant(
  stop: string | null,
  content: { type: string }[] = [{ type: "text" }],
): string {
  return JSON.stringify({
    type: "assistant",
    message: { stop_reason: stop, content },
  });
}
function user(): string {
  return JSON.stringify({ type: "user", message: { content: [] } });
}
// The SubagentStop hook_progress entry that tails a completed sidechain.
function subagentStop(): string {
  return JSON.stringify({
    type: "progress",
    data: { type: "hook_progress", hookEvent: "SubagentStop" },
  });
}

describe("sidechainIsDone", () => {
  test("empty / unreadable → not done (a just-spawned agent shouldn't vanish)", () => {
    expect(sidechainIsDone([])).toBe(false);
    expect(sidechainIsDone(["", "  "])).toBe(false);
  });

  test("final assistant on end_turn → done", () => {
    expect(
      sidechainIsDone([
        JSON.stringify({ type: "fork-context-ref" }),
        assistant("tool_use", [{ type: "tool_use" }]),
        user(),
        assistant("end_turn"),
      ]),
    ).toBe(true);
  });

  // The bug the review caught: real completed sidechains often end on a
  // null-stopped assistant followed by SubagentStop, not end_turn.
  test("null-stopped final assistant + SubagentStop tail → done", () => {
    expect(
      sidechainIsDone([assistant(null), subagentStop(), subagentStop()]),
    ).toBe(true);
  });

  test("SubagentStop is authoritative even past trailing progress", () => {
    expect(sidechainIsDone([assistant("end_turn"), subagentStop()])).toBe(true);
  });

  test("null-stopped plain answer (no hook) → done via terminal fallback", () => {
    expect(sidechainIsDone([user(), assistant(null)])).toBe(true);
  });

  test("non-tool stop reasons (stop_sequence, max_tokens) → done", () => {
    expect(sidechainIsDone([assistant("stop_sequence")])).toBe(true);
    expect(sidechainIsDone([assistant("max_tokens")])).toBe(true);
  });

  test("assistant still holding a tool_use call → running", () => {
    expect(sidechainIsDone([assistant(null, [{ type: "tool_use" }])])).toBe(
      false,
    );
    expect(
      sidechainIsDone([assistant("tool_use", [{ type: "tool_use" }])]),
    ).toBe(false);
  });

  test("last entry is a user tool_result (awaiting next turn) → running", () => {
    expect(
      sidechainIsDone([assistant("tool_use", [{ type: "tool_use" }]), user()]),
    ).toBe(false);
  });

  test("blank and malformed lines don't derail the scan", () => {
    expect(sidechainIsDone(["", "{not json", assistant("end_turn"), ""])).toBe(
      true,
    );
  });
});

function codexTaskComplete(): string {
  return JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete" },
  });
}

describe("codexRolloutIsDone", () => {
  test("task_complete tail → done", () => {
    expect(
      codexRolloutIsDone([
        JSON.stringify({ type: "response_item" }),
        codexTaskComplete(),
      ]),
    ).toBe(true);
  });

  test("no task_complete → still running", () => {
    expect(
      codexRolloutIsDone([
        JSON.stringify({ type: "response_item" }),
        JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      ]),
    ).toBe(false);
  });
});

describe("subagentCountForCodex", () => {
  test("counts fresh open child threads that have not task_completed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-codex-subagents-"));
    const dbPath = join(dir, "state_5.sqlite");
    const previousDb = process.env.COCKPIT_CODEX_STATE_DB;
    process.env.COCKPIT_CODEX_STATE_DB = dbPath;
    try {
      const now = Date.UTC(2026, 4, 26, 8, 0, 0);
      const parent = "parent-thread";
      const runningRollout = join(dir, "running.jsonl");
      const doneRollout = join(dir, "done.jsonl");
      const closedRollout = join(dir, "closed.jsonl");
      const staleRollout = join(dir, "stale.jsonl");
      writeFileSync(runningRollout, JSON.stringify({ type: "response_item" }));
      writeFileSync(doneRollout, codexTaskComplete());
      writeFileSync(closedRollout, JSON.stringify({ type: "response_item" }));
      writeFileSync(staleRollout, JSON.stringify({ type: "response_item" }));

      const db = new Database(dbPath);
      try {
        db.run(
          `create table threads (
            id text primary key,
            rollout_path text not null,
            updated_at integer not null,
            updated_at_ms integer,
            archived integer not null default 0
          )`,
        );
        db.run(
          `create table thread_spawn_edges (
            parent_thread_id text not null,
            child_thread_id text not null primary key,
            status text not null
          )`,
        );
        const insertThread = db.query(
          `insert into threads
           (id, rollout_path, updated_at, updated_at_ms, archived)
           values (?, ?, ?, ?, 0)`,
        );
        insertThread.run("running", runningRollout, now / 1000, now);
        insertThread.run("done", doneRollout, now / 1000, now);
        insertThread.run("closed", closedRollout, now / 1000, now);
        insertThread.run(
          "stale",
          staleRollout,
          (now - 20 * 60 * 1000) / 1000,
          now - 20 * 60 * 1000,
        );
        const insertEdge = db.query(
          `insert into thread_spawn_edges
           (parent_thread_id, child_thread_id, status)
           values (?, ?, ?)`,
        );
        insertEdge.run(parent, "running", "open");
        insertEdge.run(parent, "done", "open");
        insertEdge.run(parent, "closed", "closed");
        insertEdge.run(parent, "stale", "open");
      } finally {
        db.close();
      }

      expect(subagentCountForCodex(parent, now)).toBe(1);
    } finally {
      if (previousDb === undefined) delete process.env.COCKPIT_CODEX_STATE_DB;
      else process.env.COCKPIT_CODEX_STATE_DB = previousDb;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
