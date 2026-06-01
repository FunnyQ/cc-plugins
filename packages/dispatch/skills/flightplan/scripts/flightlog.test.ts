import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNoteEntry, slugFromLogPath } from "./flightlog";

const SCRIPT = join(import.meta.dir, "flightlog.ts");

describe("buildNoteEntry", () => {
  test("maps narrative metadata to a note entry", () => {
    const e = buildNoteEntry({
      task: "ui/03",
      role: "dev",
      message: "did the thing",
      ts: "2026-06-01T10:00:00.000Z",
      attempt: 2,
      agentLabel: "dev-ui-03-a2",
    });
    expect(e.kind).toBe("note");
    expect(e.role).toBe("dev");
    expect(e.message).toBe("did the thing");
    expect(e.attempt).toBe(2);
  });
});

describe("slugFromLogPath", () => {
  test("pulls the plan slug from a .flightlog/ path", () => {
    expect(slugFromLogPath("docs/my-plan/.flightlog/run.jsonl")).toBe(
      "my-plan",
    );
  });

  test("falls back to the parent dir name otherwise", () => {
    expect(slugFromLogPath("/tmp/logs/run.jsonl")).toBe("logs");
  });
});

describe("flightlog CLI", () => {
  test("log then report renders a grouped RUNLOG.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "flightlog-cli-"));
    const logFile = join(root, "my-plan", ".flightlog", "run.jsonl");

    const run = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", SCRIPT, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      return code;
    };

    expect(
      await run(
        "log",
        logFile,
        "--task",
        "ui/03",
        "--role",
        "dev",
        "--attempt",
        "1",
        "--agent",
        "dev-ui-03-a1",
        "--message",
        "Implemented the fixture shell.",
      ),
    ).toBe(0);

    expect(
      await run(
        "log",
        logFile,
        "--task",
        "backend/01",
        "--role",
        "final-review",
        "--message",
        "Whole-tree review passed.",
      ),
    ).toBe(0);

    const out = join(root, "my-plan", ".flightlog", "RUNLOG.md");
    expect(await run("report", logFile)).toBe(0);

    const md = await readFile(out, "utf-8");
    expect(md).toContain("# Run log — my-plan");
    expect(md).toContain("## ui/03");
    expect(md).toContain("## backend/01");
    expect(md).toContain("Implemented the fixture shell.");
    expect(md).toContain("dev-ui-03-a1");

    await rm(root, { recursive: true });
  });

  test("log requires --task/--role/--message (exits 2)", async () => {
    const root = await mkdtemp(join(tmpdir(), "flightlog-cli-"));
    const logFile = join(root, "run.jsonl");
    const proc = Bun.spawn(["bun", SCRIPT, "log", logFile, "--task", "ui/03"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(2);
    await rm(root, { recursive: true });
  });
});
