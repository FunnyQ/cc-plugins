import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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

  // The old whole-file read failed here and the catch beneath it turned that
  // into a silently empty title. Fixture is a tmpdir APFS sparse file.
  test("讀到第一則 user 訊息就停，不會讀完 2.4 GB 的 transcript", () => {
    const sessionId = "99999999-8888-7777-6666-555555555555";
    const dir = join(process.env.COCKPIT_CLAUDE_PROJECTS_DIR!, "huge");
    mkdirSync(dir, { recursive: true });
    const first = JSON.stringify({
      type: "user",
      message: { role: "user", content: "第一則訊息" },
    });
    const holeEnd = 2_400_000_000;

    const fd = openSync(join(dir, `${sessionId}.jsonl`), "w");
    try {
      writeSync(fd, `${first}\n`);
      const nl = Buffer.from("\n");
      for (let at = 600_000; at < holeEnd; at += 600_000) {
        writeSync(fd, nl, 0, 1, at);
      }
      ftruncateSync(fd, holeEnd);
    } finally {
      closeSync(fd);
    }

    expect(resolveHistoricalSessionTitle("claude", sessionId)).toBe(
      "第一則訊息",
    );
  }, 600_000);
});
