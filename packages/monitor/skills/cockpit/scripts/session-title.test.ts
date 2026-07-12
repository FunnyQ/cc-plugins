import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { resolveHistoricalSessionTitle } from "./session-title";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cockpit-session-title-"));
  process.env.COCKPIT_CLAUDE_PROJECTS_DIR = join(root, "claude-projects");
  process.env.COCKPIT_CODEX_STATE_DB = join(root, "state.sqlite");
  process.env.COCKPIT_OPENCODE_DB = join(root, "opencode.sqlite");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.COCKPIT_CLAUDE_PROJECTS_DIR;
  delete process.env.COCKPIT_CODEX_STATE_DB;
  delete process.env.COCKPIT_OPENCODE_DB;
});

describe("resolveHistoricalSessionTitle", () => {
  test("reads a historical Codex title by thread id", () => {
    const db = new Database(process.env.COCKPIT_CODEX_STATE_DB!);
    db.run("create table threads (id text primary key, title text not null)");
    db.query("insert into threads (id, title) values (?, ?)").run(
      "codex-session",
      "Persist cockpit session titles",
    );
    db.close();

    expect(resolveHistoricalSessionTitle("codex", "codex-session")).toBe(
      "Persist cockpit session titles",
    );
  });

  test("derives a missing Claude title from the first user transcript entry", () => {
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const dir = join(process.env.COCKPIT_CLAUDE_PROJECTS_DIR!, "project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: "progress", data: { status: "starting" } }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "Add historical session titles\nwith a safe fallback",
          },
        }),
      ].join("\n"),
    );

    expect(resolveHistoricalSessionTitle("claude", sessionId)).toBe(
      "Add historical session titles with a safe fallback",
    );
  });

  test("returns an empty title when the historical source has no match", () => {
    expect(resolveHistoricalSessionTitle("claude", "missing")).toBe("");
  });
});
