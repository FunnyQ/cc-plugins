import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNoteEntry, buildStateEntry, slugFromLogPath } from "./flightlog";

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

  test("passes phase through and omits it when absent", () => {
    const base = {
      task: "ui/03",
      role: "dev",
      message: "",
      ts: "2026-06-01T10:00:00.000Z",
    };
    expect(buildNoteEntry({ ...base, phase: "start" }).phase).toBe("start");
    const legacy = buildNoteEntry(base);
    expect(legacy).not.toHaveProperty("phase");
    expect(JSON.stringify(legacy)).toBe(
      '{"kind":"note","ts":"2026-06-01T10:00:00.000Z","task":"ui/03","role":"dev","message":""}',
    );
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

  test("start phase works without a message", async () => {
    const root = await mkdtemp(join(tmpdir(), "flightlog-cli-"));
    const logFile = join(root, "run.jsonl");
    const proc = Bun.spawn([
      "bun",
      SCRIPT,
      "log",
      logFile,
      "--task",
      "ui/03",
      "--role",
      "dev",
      "--phase",
      "start",
    ]);
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(await readFile(logFile, "utf-8"))).toMatchObject({
      phase: "start",
      message: "",
    });
    await rm(root, { recursive: true });
  });

  test("rejects invalid phase values with allowed values", async () => {
    const root = await mkdtemp(join(tmpdir(), "flightlog-cli-"));
    const logFile = join(root, "run.jsonl");
    const proc = Bun.spawn(
      [
        "bun",
        SCRIPT,
        "log",
        logFile,
        "--task",
        "ui/03",
        "--role",
        "dev",
        "--phase",
        "bogus",
        "--message",
        "test",
      ],
      { stderr: "pipe" },
    );
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("start or end");
    await rm(root, { recursive: true });
  });
});

describe("progress CLI", () => {
  test("an unrecorded task prints no attempts and exits 0, not an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "flightlog-progress-"));
    const logFile = join(root, "run.jsonl");
    const log = Bun.spawn(
      ["bun", SCRIPT, "log", logFile, "--task", "ui/01", "--role", "dev", "--message", "hi"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await log.exited).toBe(0);
    const proc = Bun.spawn(["bun", SCRIPT, "progress", logFile, "--task", "ui/02"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("no attempts recorded for ui/02");
    await rm(root, { recursive: true });
  });
});

describe("state CLI", () => {
  test("buildStateEntry preserves caller metadata without agent-turn fields", () => {
    const meta = { task: "ui/03", state: "blocked", ts: "fixed", agentLabel: "workflow", message: "Waiting" } satisfies Parameters<typeof buildStateEntry>[0];
    expect(buildStateEntry(meta)).toEqual({ kind: "state", ...meta });
    expect(buildStateEntry(meta)).not.toHaveProperty("attempt");
    expect(buildStateEntry(meta)).not.toHaveProperty("role");
  });

  test.each([
    { args: ["--state", "done"], error: "--task" },
    { args: ["--task", "ui/03"], error: "--state" },
    { args: ["--task", "ui/03", "--state"], error: "--state" },
    { args: ["--task", "ui/03", "--state", "other"], error: "--state" },
    { args: ["--task", "ui/03", "--state", "blocked"], error: "--message" },
    { args: ["--task", "ui/03", "--state", "failed"], error: "--message" },
    { args: ["--task", "ui/03", "--state", "failed", "--message"], error: "--message" },
  ])("rejects invalid flags: $args", async ({ args, error }) => {
    const root = await mkdtemp(join(tmpdir(), "flightlog-state-"));
    try {
      const proc = Bun.spawn(["bun", SCRIPT, "state", join(root, "run.jsonl"), ...args], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(2);
      expect(await new Response(proc.stderr).text()).toContain(error);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test.each(["done", "blocked", "failed"])("appends %s with optional agent and dash-prefixed reason", async (state) => {
    const root = await mkdtemp(join(tmpdir(), "flightlog-state-"));
    try {
      const logFile = join(root, "run.jsonl");
      const args = state === "done" ? [] : ["--message", "--waiting for input"];
      const proc = Bun.spawn(["bun", SCRIPT, "state", logFile, "--task", "ui/03", "--state", state, "--agent", "workflow", ...args], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(0);
      const entry = JSON.parse(await readFile(logFile, "utf-8"));
      expect(entry).toEqual({ kind: "state", task: "ui/03", state, agentLabel: "workflow", ts: expect.any(String), ...(state === "done" ? {} : { message: "--waiting for input" }) });
      expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
