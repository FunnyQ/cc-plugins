import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildNoteEntry, buildStateEntry, slugFromLogPath } from "./flightlog";
import { goalHash } from "./lib/goal-mode";

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
      [
        "bun",
        SCRIPT,
        "log",
        logFile,
        "--task",
        "ui/01",
        "--role",
        "dev",
        "--message",
        "hi",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await log.exited).toBe(0);
    const proc = Bun.spawn(
      ["bun", SCRIPT, "progress", logFile, "--task", "ui/02"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain(
      "no attempts recorded for ui/02",
    );
    await rm(root, { recursive: true });
  });
});

describe("state CLI", () => {
  test("buildStateEntry preserves caller metadata without agent-turn fields", () => {
    const meta = {
      task: "ui/03",
      state: "blocked",
      ts: "fixed",
      agentLabel: "workflow",
      message: "Waiting",
    } satisfies Parameters<typeof buildStateEntry>[0];
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
    {
      args: ["--task", "ui/03", "--state", "failed", "--message"],
      error: "--message",
    },
  ])("rejects invalid flags: $args", async ({ args, error }) => {
    const root = await mkdtemp(join(tmpdir(), "flightlog-state-"));
    try {
      const proc = Bun.spawn(
        ["bun", SCRIPT, "state", join(root, "run.jsonl"), ...args],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await proc.exited).toBe(2);
      expect(await new Response(proc.stderr).text()).toContain(error);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test.each(["done", "blocked", "failed"])(
    "appends %s with optional agent and dash-prefixed reason",
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), "flightlog-state-"));
      try {
        const logFile = join(root, "run.jsonl");
        const args =
          state === "done" ? [] : ["--message", "--waiting for input"];
        const proc = Bun.spawn(
          [
            "bun",
            SCRIPT,
            "state",
            logFile,
            "--task",
            "ui/03",
            "--state",
            state,
            "--agent",
            "workflow",
            ...args,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        expect(await proc.exited).toBe(0);
        const entry = JSON.parse(await readFile(logFile, "utf-8"));
        expect(entry).toEqual({
          kind: "state",
          task: "ui/03",
          state,
          agentLabel: "workflow",
          ts: expect.any(String),
          ...(state === "done" ? {} : { message: "--waiting for input" }),
        });
        expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
      } finally {
        await rm(root, { recursive: true });
      }
    },
  );
});

const PLAN_MD = [
  "# Plan",
  "",
  "## Goals",
  "",
  "- Ship goal mode.",
  "",
  "## Requirements",
  "",
  "- Be pure.",
  "",
].join("\n");

const taskMd = (
  ref: string,
  opts: { status?: string; dependsOn?: string; verification?: string } = {},
): string => {
  const [bucket, nn] = ref.split("/");
  return [
    `# ${bucket.toUpperCase()}-${nn}: Task ${ref}`,
    "",
    `> **Status**: ${opts.status ?? "todo"}`,
    `> **Depends on**: ${opts.dependsOn ?? "none"}`,
    "",
    "## Scope",
    "",
    "Build the thing.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] it works",
    "",
    "## Verification",
    "",
    `- [ ] ${opts.verification ?? "`bun test` passes"}`,
    "",
    "## Eval rubric",
    "",
    "> Pass when weighted score > 4.",
    "",
  ].join("\n");
};

type Plan = {
  root: string;
  planDir: string;
  plan: string;
  tasks: string;
  log: string;
  run: (
    ...args: string[]
  ) => Promise<{ code: number; out: string; err: string }>;
  git: (...args: string[]) => void;
};

async function planFixture(
  statuses: { "ui/01": string; "ui/02": string } = {
    "ui/01": "blocked",
    "ui/02": "todo",
  },
  planRel = "docs/toy",
): Promise<Plan> {
  const root = await mkdtemp(join(tmpdir(), "flightlog-goal-"));
  const planDir = join(root, planRel);
  const tasks = join(planDir, "tasks");
  await mkdir(join(tasks, "ui"), { recursive: true });
  const plan = join(planDir, "PLAN.md");
  await writeFile(plan, PLAN_MD);
  await writeFile(
    join(tasks, "ui", "01-first.md"),
    taskMd("ui/01", { status: statuses["ui/01"] }),
  );
  await writeFile(
    join(tasks, "ui", "02-second.md"),
    taskMd("ui/02", { status: statuses["ui/02"], dependsOn: "ui/01" }),
  );
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  };
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", SCRIPT, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, out, err };
  };
  return {
    root,
    planDir,
    plan,
    tasks,
    log: join(planDir, ".flightlog", "run.jsonl"),
    run,
    git,
  };
}

function commitAll(p: Plan) {
  p.git("init", "-q");
  p.git("add", ".");
  p.git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "init",
  );
}

const readEntries = async (log: string) =>
  (await readFile(log, "utf-8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

const escalationPayload = (escalations: unknown[]) =>
  encodeURIComponent(
    JSON.stringify({
      escalations,
      cleanupFailures: [],
      drained: [],
      aborted: null,
      completed: [],
      needsHuman: [],
    }),
  );

describe("goal-mode CLI", () => {
  test("repairs --status exits 2 on a trail with no flight entry", async () => {
    const p = await planFixture();
    try {
      await p.run("state", p.log, "--task", "ui/01", "--state", "done");
      const res = await p.run("repairs", p.log, "--tasks", p.tasks, "--status");
      expect(res.code).toBe(2);
      expect(res.err).toContain("no goal-mode flight started");
      expect(res.out).toBe("");
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test("flight-start then repairs --status prints continue for a blocked task", async () => {
    const p = await planFixture();
    try {
      expect((await p.run("flight-start", p.log, "--plan", p.plan)).code).toBe(
        0,
      );
      expect(await readEntries(p.log)).toEqual([
        {
          kind: "flight",
          ts: expect.any(String),
          task: "(flight)",
          goalHash: goalHash(PLAN_MD),
          planPath: p.plan,
        },
      ]);
      const res = await p.run("repairs", p.log, "--tasks", p.tasks, "--status");
      expect(res).toEqual({ code: 0, out: "continue\n", err: "" });

      const json = await p.run("repairs", p.log, "--tasks", p.tasks, "--json");
      expect(json.code).toBe(0);
      expect(JSON.parse(json.out)).toEqual({
        flight: 0,
        byTask: {},
        status: "continue",
      });
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test("repairs --status prints complete when every task is done", async () => {
    const p = await planFixture({ "ui/01": "done", "ui/02": "done" });
    try {
      await p.run("flight-start", p.log, "--plan", p.plan);
      const res = await p.run("repairs", p.log, "--tasks", p.tasks, "--status");
      expect(res.out).toBe("complete\n");
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test("escalations decodes a payload with quotes, newlines and percent signs", async () => {
    const p = await planFixture();
    try {
      const reason = `it's "quoted"\nnext line 100% done`;
      const payload = {
        escalations: [
          {
            task: "ui/01",
            attempt: 3,
            class: "capped",
            infrastructure: false,
            parked: true,
            reason,
          },
        ],
        cleanupFailures: [{ ref: "ui/02", path: "/tmp/wt/ui-02" }],
        drained: ["ui/03"],
        aborted: { reason: "leak", paths: [] },
        completed: ["ui/02"],
        needsHuman: [{ task: "ui/02", criteria: ["looks right (human)"] }],
      };
      const encoded = encodeURIComponent(JSON.stringify(payload)).replace(
        /'/g,
        "%27",
      );
      const res = await p.run("escalations", p.log, "--payload", encoded);
      expect(res.code).toBe(0);
      const entries = await readEntries(p.log);
      expect(entries.map((e) => e.kind)).toEqual([
        "escalation",
        "escalation",
        "run-end",
      ]);
      expect(entries[0]).toEqual({
        kind: "escalation",
        ts: expect.any(String),
        task: "ui/01",
        attempt: 3,
        class: "capped",
        infrastructure: false,
        parked: true,
        reason,
      });
      expect(entries[1]).toEqual({
        kind: "escalation",
        ts: expect.any(String),
        task: "ui/02",
        attempt: 0,
        class: "cleanup-failure",
        infrastructure: true,
        parked: false,
        reason: "worktree removal could not be confirmed: /tmp/wt/ui-02",
      });
      expect(entries[2]).toEqual({
        kind: "run-end",
        ts: expect.any(String),
        task: "(flight)",
        aborted: true,
        completed: ["ui/02"],
        drained: ["ui/03"],
        needsHuman: [{ task: "ui/02", criteria: ["looks right (human)"] }],
      });
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test.each([
    ["not JSON", "%7Bnope"],
    ["missing arrays", encodeURIComponent("{}")],
    [
      "an escalation without a known class",
      escalationPayload([{ task: "ui/01", attempt: 1, reason: "x" }]),
    ],
  ])("escalations exits 2 on %s", async (_, payload) => {
    const p = await planFixture();
    try {
      const res = await p.run("escalations", p.log, "--payload", payload);
      expect(res.code).toBe(2);
      expect(await readFile(p.log, "utf-8").catch(() => "")).toBe("");
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test("repair refuses a fourth fix on one task with exit 1", async () => {
    const p = await planFixture();
    try {
      await p.run("flight-start", p.log, "--plan", p.plan);
      const reasonFile = join(p.root, "reason.txt");
      await writeFile(reasonFile, "Verification greps a path no task makes");
      const fix = () =>
        p.run(
          "repair",
          p.log,
          "--task",
          "ui/01",
          "--verdict",
          "fix",
          "--reason-file",
          reasonFile,
          "--pattern",
          "grep of an uncreated path",
          "--changed",
          "ui/01,ui/02",
          "--reentry",
          '{"ui/01":"verify","ui/02":"dev"}',
        );
      for (let i = 0; i < 3; i++) expect((await fix()).code).toBe(0);
      const fourth = await fix();
      expect(fourth.code).toBe(1);
      expect(fourth.err).toContain("repair budget spent");

      const repairs = (await readEntries(p.log)).filter(
        (e) => e.kind === "repair",
      );
      expect(repairs).toHaveLength(3);
      expect(repairs[0]).toEqual({
        kind: "repair",
        ts: expect.any(String),
        task: "ui/01",
        verdict: "fix",
        reason: "Verification greps a path no task makes",
        pattern: "grep of an uncreated path",
        changed: ["ui/01", "ui/02"],
        reentry: { "ui/01": "verify", "ui/02": "dev" },
      });
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test("repair --flight halt records a (flight) entry and exhausts the flight", async () => {
    const p = await planFixture();
    try {
      await p.run("flight-start", p.log, "--plan", p.plan);
      const reasonFile = join(p.root, "reason.txt");
      await writeFile(reasonFile, "leak abort");
      const res = await p.run(
        "repair",
        p.log,
        "--flight",
        "--verdict",
        "halt",
        "--reason-file",
        reasonFile,
      );
      expect(res.code).toBe(0);
      expect((await readEntries(p.log)).at(-1)).toEqual({
        kind: "repair",
        ts: expect.any(String),
        task: "(flight)",
        verdict: "halt",
        reason: "leak abort",
      });
      const status = await p.run(
        "repairs",
        p.log,
        "--tasks",
        p.tasks,
        "--status",
      );
      expect(status.out).toBe("exhausted\n");
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test.each([
    ["an unknown verdict", ["--task", "ui/01", "--verdict", "maybe"]],
    [
      "both --task and --flight",
      ["--task", "ui/01", "--flight", "--verdict", "fix"],
    ],
    ["neither --task nor --flight", ["--verdict", "fix"]],
  ])("repair exits 2 on %s", async (_, args) => {
    const p = await planFixture();
    try {
      await p.run("flight-start", p.log, "--plan", p.plan);
      const reasonFile = join(p.root, "reason.txt");
      await writeFile(reasonFile, "x");
      const res = await p.run(
        "repair",
        p.log,
        ...args,
        "--reason-file",
        reasonFile,
      );
      expect(res.code).toBe(2);
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test("report --flight writes FLIGHTREPORT.md and leaves RUNLOG.md untouched", async () => {
    const p = await planFixture();
    try {
      await mkdir(dirname(p.log), { recursive: true });
      const runlog = join(dirname(p.log), "RUNLOG.md");
      await writeFile(runlog, "previous runlog\n");
      await p.run("flight-start", p.log, "--plan", p.plan);
      const deferred = join(p.planDir, "DEFERRED.md");
      await writeFile(
        deferred,
        "# Deferred criteria — toy\n\n- [ ] it is fast\n  - from: ui/01 · deferred: 2026-11-14\n  - why: needs a later leg\n",
      );
      const res = await p.run(
        "report",
        p.log,
        "--flight",
        "--deferred",
        deferred,
      );
      expect(res.code).toBe(0);
      const out = join(dirname(p.log), "FLIGHTREPORT.md");
      expect(res.out).toBe(`${out}\n`);
      const md = await readFile(out, "utf-8");
      expect(md).toContain("# Flight report — toy");
      expect(md).toContain("Outcome: **continue**");
      expect(md).toContain("## Deferred criteria");
      expect(md).toContain("- [ ] it is fast");
      expect(md).toContain("- ui/01: no escalation or repair recorded");
      expect(await readFile(runlog, "utf-8")).toBe("previous runlog\n");
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test("report --flight omits a missing DEFERRED.md", async () => {
    const p = await planFixture();
    try {
      await p.run("flight-start", p.log, "--plan", p.plan);
      const res = await p.run(
        "report",
        p.log,
        "--flight",
        "--deferred",
        join(p.planDir, "DEFERRED.md"),
      );
      expect(res.code).toBe(0);
      expect(await readFile(res.out.trim(), "utf-8")).not.toContain(
        "## Deferred criteria",
      );
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test("report --flight lists unreadable tasks and warns on stderr", async () => {
    const p = await planFixture();
    try {
      await p.run("flight-start", p.log, "--plan", p.plan);
      await writeFile(join(p.tasks, "ui", "02-second.md"), "no heading\n");
      const res = await p.run("report", p.log, "--flight");
      expect(res.code).toBe(0);
      expect(res.err).toContain("02-second.md: missing H1");
      const md = await readFile(res.out.trim(), "utf-8");
      expect(md).toContain(
        `## Unreadable tasks\n\n- ${join(p.tasks, "ui", "02-second.md")}: missing H1\n`,
      );
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  test("report --flight exits 2 without a flight entry", async () => {
    const p = await planFixture();
    try {
      const res = await p.run("report", p.log, "--flight");
      expect(res.code).toBe(2);
      expect(res.err).toContain("no goal-mode flight started");
    } finally {
      await rm(p.root, { recursive: true });
    }
  });

  describe("guard", () => {
    const guard = async (p: Plan, verdict = "fix", kept = "") => {
      const justified = join(p.root, "verdict.json");
      await writeFile(
        justified,
        JSON.stringify({
          verdict,
          justified: [
            { task: "ui/01", before: "- [ ] `bun test` passes", why: "x" },
            { task: "ui/01", before: "- [ ] it works", why: "x" },
          ],
        }),
      );
      return p.run(
        "guard",
        p.log,
        "--plan",
        p.plan,
        "--tasks",
        p.tasks,
        "--verdict",
        verdict,
        "--justified",
        justified,
        "--kept",
        kept,
      );
    };

    const devDone = (p: Plan, message: string) =>
      p.run(
        "log",
        p.log,
        "--task",
        "ui/01",
        "--role",
        "dev",
        "--attempt",
        "1",
        "--message",
        message,
      );

    const editGate = (p: Plan, status = "blocked") =>
      writeFile(
        join(p.tasks, "ui", "01-first.md"),
        taskMd("ui/01", { status, verification: "`bun x` passes" }),
      );

    test("a gate-only change on a kept, worked task re-enters at verify", async () => {
      const p = await planFixture();
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await devDone(p, "built it");
        await editGate(p);
        const res = await guard(p, "fix", "ui/01");
        expect(JSON.parse(res.out)).toEqual({
          ok: true,
          reentry: { "ui/01": "verify" },
        });
        expect(res.code).toBe(0);
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("the same change re-enters at dev when the worktree is not kept", async () => {
      const p = await planFixture();
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await devDone(p, "built it");
        await editGate(p);
        const res = await guard(p, "fix", "");
        expect(JSON.parse(res.out)).toEqual({
          ok: true,
          reentry: { "ui/01": "dev" },
        });
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("a dev-reported plan defect re-enters at dev", async () => {
      const p = await planFixture();
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await devDone(p, "PLAN DEFECT");
        await p.run(
          "escalations",
          p.log,
          "--payload",
          escalationPayload([
            {
              task: "ui/01",
              attempt: 1,
              class: "plan-defect",
              infrastructure: false,
              parked: true,
              reason: "dev said PLAN DEFECT",
            },
          ]),
        );
        await editGate(p);
        const res = await guard(p, "fix", "ui/01");
        expect(JSON.parse(res.out)).toEqual({
          ok: true,
          reentry: { "ui/01": "dev" },
        });
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("an edit to a task done at HEAD fails with exit 1", async () => {
      const p = await planFixture({ "ui/01": "done", "ui/02": "blocked" });
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await editGate(p, "todo");
        const res = await guard(p);
        expect(res.code).toBe(1);
        expect(JSON.parse(res.out).violations).toContain(
          "ui/01 is done and must not be edited",
        );
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("a goal edit after flight-start fails", async () => {
      const p = await planFixture();
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await writeFile(p.plan, PLAN_MD.replace("Ship", "Skip"));
        const res = await guard(p);
        expect(res.code).toBe(1);
        expect(JSON.parse(res.out).violations).toContain(
          "PLAN.md goal section changed since the flight started",
        );
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("a task marked done in the trail but not committed is protected", async () => {
      const p = await planFixture({ "ui/01": "todo", "ui/02": "todo" });
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await p.run("state", p.log, "--task", "ui/01", "--state", "done");
        await editGate(p, "todo");
        const res = await guard(p);
        expect(res.code).toBe(1);
        expect(JSON.parse(res.out).violations).toContain(
          "ui/01 is done and must not be edited",
        );
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("a task completed in the last run-end is protected", async () => {
      const p = await planFixture({ "ui/01": "todo", "ui/02": "todo" });
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await p.run(
          "escalations",
          p.log,
          "--payload",
          encodeURIComponent(
            JSON.stringify({
              escalations: [],
              cleanupFailures: [],
              drained: [],
              aborted: null,
              completed: ["ui/01"],
              needsHuman: [],
            }),
          ),
        );
        await editGate(p, "todo");
        const res = await guard(p);
        expect(JSON.parse(res.out).violations).toContain(
          "ui/01 is done and must not be edited",
        );
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("an unparseable task is reported as such, not as deleted", async () => {
      const p = await planFixture();
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await writeFile(join(p.tasks, "ui", "01-first.md"), "no heading\n");
        const res = await guard(p);
        expect(res.code).toBe(1);
        expect(JSON.parse(res.out).violations).toEqual([
          "unparseable task docs/toy/tasks/ui/01-first.md: missing H1",
        ]);
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("a defer inside a waypoints leg passes with DEFERRED.md written", async () => {
      const p = await planFixture(
        { "ui/01": "blocked", "ui/02": "todo" },
        "docs/p/legs/01-a",
      );
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        const file = join(p.tasks, "ui", "01-first.md");
        await writeFile(
          file,
          (await readFile(file, "utf-8")).replace("- [ ] it works\n", ""),
        );
        await writeFile(
          join(p.planDir, "DEFERRED.md"),
          "# Deferred criteria — 01-a\n\n- [ ] it works\n  - from: ui/01 · deferred: 2026-11-14\n  - why: needs the next leg\n",
        );
        const res = await guard(p, "defer");
        expect(JSON.parse(res.out)).toEqual({
          ok: true,
          reentry: { "ui/01": "dev" },
        });
        expect(res.code).toBe(0);
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("a stray file under the plan dir fails as unexpected", async () => {
      const p = await planFixture();
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await writeFile(join(p.planDir, "ATTESTATION.md"), "I attest\n");
        await writeFile(join(p.root, "outside.md"), "not in the plan\n");
        const res = await guard(p);
        expect(res.code).toBe(1);
        expect(JSON.parse(res.out)).toEqual({
          ok: false,
          violations: ["unexpected file docs/toy/ATTESTATION.md"],
        });
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("defer outside a waypoints leg fails, and DEFERRED.md is not stray for it", async () => {
      const p = await planFixture();
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await writeFile(join(p.planDir, "DEFERRED.md"), "# Deferred\n");
        const res = await guard(p, "defer");
        expect(res.code).toBe(1);
        expect(JSON.parse(res.out).violations).toEqual([
          "defer is only valid inside a waypoints leg",
        ]);
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("DEFERRED.md is stray on a fix verdict", async () => {
      const p = await planFixture();
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        await writeFile(join(p.planDir, "DEFERRED.md"), "# Deferred\n");
        const res = await guard(p);
        expect(res.code).toBe(1);
        expect(JSON.parse(res.out).violations).toEqual([
          "unexpected file docs/toy/DEFERRED.md",
        ]);
      } finally {
        await rm(p.root, { recursive: true });
      }
    });

    test("guard exits 2 when --kept is missing", async () => {
      const p = await planFixture();
      try {
        commitAll(p);
        await p.run("flight-start", p.log, "--plan", p.plan);
        const justified = join(p.root, "justified.json");
        await writeFile(justified, "[]");
        const res = await p.run(
          "guard",
          p.log,
          "--plan",
          p.plan,
          "--tasks",
          p.tasks,
          "--verdict",
          "fix",
          "--justified",
          justified,
        );
        expect(res.code).toBe(2);
      } finally {
        await rm(p.root, { recursive: true });
      }
    });
  });
});
