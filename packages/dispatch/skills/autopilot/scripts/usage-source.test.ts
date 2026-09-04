import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixture } from "./usage-fixture";
import {
  addUsage,
  createTranscriptSource,
  parseAgentPrompt,
  projectSlug,
  repoRootOf,
} from "./usage-source";
import { emptyCounts, type TokenCounts } from "./usage-types";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "usage-source-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsonl(path: string, lines: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function appendJsonl(path: string, lines: unknown[]): void {
  const existing = Bun.file(path);
  const prefix = existing.size > 0 ? "\n" : "";
  writeFileSync(
    path,
    prefix + lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    { flag: "a" },
  );
}

/**
 * Build a minimal `<projectsRoot>/<slug>/session/subagents/workflows/wf_x/agent-<n>.jsonl`
 * layout, and return its path, ready for the test to write lines into.
 */
function agentPath(projectsRoot: string, slug: string, name: string): string {
  return join(
    projectsRoot,
    slug,
    "session-1",
    "subagents",
    "workflows",
    "wf_1",
    `agent-${name}.jsonl`,
  );
}

function announceUser(
  planDir: string,
  task: string,
  role: string,
  attempt?: number,
  ts = "2026-01-01T00:00:00.000Z",
) {
  const attemptPart = attempt !== undefined ? ` --attempt ${attempt}` : "";
  return {
    type: "user",
    timestamp: ts,
    message: {
      role: "user",
      content: `First, announce yourself: bun scripts/flightlog.ts log ${planDir}/.flightlog/run.jsonl --task ${task} --role ${role}${attemptPart} --agent "<your label>" --phase start\nThen proceed.`,
    },
  };
}

function assistant(model: string | undefined, usage: Record<string, unknown>) {
  const message: Record<string, unknown> = { usage };
  if (model !== undefined) message.model = model;
  return { type: "assistant", message };
}

/** One snapshot of a billed request: several share a `requestId`/`message.id` pair. */
function snapshot(
  requestId: string,
  messageId: string,
  usage: Record<string, unknown>,
  uuid?: string,
) {
  return {
    type: "assistant",
    requestId,
    uuid,
    message: { id: messageId, model: "claude-opus-5", usage },
  };
}

describe("projectSlug", () => {
  test("replaces non-alphanumeric characters and keeps case", () => {
    expect(projectSlug("/Users/dev/Projects/q-lab/cc-plugins")).toBe(
      "-Users-dev-Projects-q-lab-cc-plugins",
    );
  });

  test("doubles the dash where a dot sat", () => {
    expect(projectSlug("/Users/dev/.claude")).toBe("-Users-dev--claude");
  });
});

describe("repoRootOf", () => {
  test("finds a root whose .git is a plain file (git worktree shape)", () => {
    withTempDir((dir) => {
      const root = join(dir, "repo");
      const planDir = join(root, "docs", "plan");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
      expect(repoRootOf(planDir)).toBe(root);
    });
  });

  test("returns null when no .git exists above the input", () => {
    withTempDir((dir) => {
      const planDir = join(dir, "no-repo", "plan");
      mkdirSync(planDir, { recursive: true });
      expect(repoRootOf(planDir)).toBeNull();
    });
  });
});

describe("parseAgentPrompt", () => {
  test("extracts task, role, and attempt from the announce shape", () => {
    expect(
      parseAgentPrompt(
        'log /x/.flightlog/run.jsonl --task integration/01 --role review --attempt 1 --agent "x" --phase start',
      ),
    ).toEqual({ task: "integration/01", role: "review", attempt: 1 });
  });

  test("omits attempt when the announce line does not carry one", () => {
    expect(
      parseAgentPrompt(
        'log /x/.flightlog/run.jsonl --task scout --role scout --agent "x" --phase start',
      ),
    ).toEqual({ task: "scout", role: "scout", attempt: undefined });
  });

  test("extracts task and role mark-done from the finalize shape", () => {
    expect(
      parseAgentPrompt(
        "Finalize flightplan task orchestrator/04 at /x/tasks/orchestrator/04-vendor-rung.md. Do this in three steps.",
      ),
    ).toEqual({
      task: "orchestrator/04",
      role: "mark-done",
      attempt: undefined,
    });
  });

  test("returns all-null when neither shape matches", () => {
    expect(parseAgentPrompt("just some unrelated text")).toEqual({
      task: null,
      role: null,
      attempt: undefined,
    });
  });

  test("stringifies array content before matching", () => {
    expect(
      parseAgentPrompt([
        { type: "text", text: "--task ui/03 --role dev --attempt 2" },
      ]),
    ).toEqual({ task: "ui/03", role: "dev", attempt: 2 });
  });
});

describe("emptyCounts / addUsage", () => {
  test("emptyCounts starts every field at zero", () => {
    expect(emptyCounts()).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("maps the four wire keys onto camelCase fields", () => {
    const counts = emptyCounts();
    addUsage(counts, {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    });
    expect(counts).toEqual({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
    });
  });

  test("accumulates across calls", () => {
    const counts = emptyCounts();
    addUsage(counts, { input_tokens: 1 });
    addUsage(counts, { input_tokens: 2 });
    expect(counts.input).toBe(3);
  });

  test("skips non-integer and unknown keys", () => {
    const counts = emptyCounts();
    addUsage(counts, {
      input_tokens: 1.5,
      output_tokens: "10",
      cache_read_input_tokens: 5,
      some_future_key: { nested: true },
    });
    expect(counts).toEqual({
      input: 0,
      output: 0,
      cacheRead: 5,
      cacheWrite: 0,
    });
  });

  test("is a no-op on a non-object", () => {
    const counts = emptyCounts();
    addUsage(counts, null);
    addUsage(counts, "usage");
    addUsage(counts, 5);
    expect(counts).toEqual(emptyCounts());
  });

  // A negative would render as `N/A` once it drove a total below zero, so corrupt
  // data would read as "no transcript" instead of as corruption.
  test("skips a negative counter", () => {
    const counts = emptyCounts();
    addUsage(counts, { input_tokens: 100 });
    addUsage(counts, { input_tokens: -100, output_tokens: -1 });
    expect(counts).toEqual({
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("skips an integer past the safe range", () => {
    const counts = emptyCounts();
    addUsage(counts, { input_tokens: Number.MAX_SAFE_INTEGER + 2 });
    expect(counts).toEqual(emptyCounts());
  });
});

describe("createTranscriptSource", () => {
  function setup(): {
    root: string;
    planDir: string;
    projectsRoot: string;
    slug: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "usage-source-fs-"));
    const repoRoot = join(root, "repo");
    const planDir = join(repoRoot, "docs", "myplan");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), "gitdir: x\n");
    const projectsRoot = join(root, "projects");
    const slug = projectSlug(repoRoot);
    return { root, planDir, projectsRoot, slug };
  }

  test("reads usage from an included transcript", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("claude-haiku-4-5-20251001", {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 400,
        }),
      ]);

      const source = createTranscriptSource(planDir, projectsRoot);
      const agents = source.read();
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        file,
        task: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        models: ["claude-haiku-4-5-20251001"],
        counts: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns [] when the slug directory does not exist yet, then real results once it appears", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const source = createTranscriptSource(planDir, projectsRoot);
      expect(source.read()).toEqual([]);

      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("claude-haiku-4-5-20251001", { input_tokens: 5 }),
      ]);

      const agents = source.read();
      expect(agents).toHaveLength(1);
      expect(agents[0]!.counts.input).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a second read over unchanged files reads no new bytes and returns identical counts", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("m", { input_tokens: 7, output_tokens: 8 }),
      ]);

      const source = createTranscriptSource(planDir, projectsRoot);
      const first = source.read();
      const second = source.read();
      expect(second).toEqual(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a truncated file is re-read from zero, not double-counted", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("m", { input_tokens: 100 }),
        assistant("m", { input_tokens: 100 }),
      ]);

      const source = createTranscriptSource(planDir, projectsRoot);
      const first = source.read();
      expect(first[0]!.counts.input).toBe(200);

      // Truncate and replace with fresh, smaller content naming the same plan.
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1, "2026-01-01T00:09:00.000Z"),
        assistant("m", { input_tokens: 9 }),
      ]);

      const second = source.read();
      expect(second[0]!.counts.input).toBe(9);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a transcript not naming the plan is excluded and never reopened", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        {
          type: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "some other plan entirely" },
        },
      ]);

      const source = createTranscriptSource(planDir, projectsRoot);
      expect(source.read()).toEqual([]);

      // Append content that would match the plan, if it were re-examined.
      appendJsonl(file, [assistant("m", { input_tokens: 1 })]);
      appendJsonl(file, [
        {
          type: "user",
          timestamp: "2026-01-01T00:01:00.000Z",
          message: { role: "user", content: planDir },
        },
      ]);

      expect(source.read()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `docs/foo` and `docs/foo-bar` are siblings under one repo, so a plain substring
  // test hands every `foo-bar` transcript to `foo` and inflates its plan total.
  test("a sibling plan whose name merely starts with this one's is excluded", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const siblingDir = `${planDir}-extra`;
      jsonl(agentPath(projectsRoot, slug, "sibling"), [
        announceUser(siblingDir, "work/09", "dev", 1),
        assistant("m", { input_tokens: 500 }),
      ]);
      jsonl(agentPath(projectsRoot, slug, "mine"), [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("m", { input_tokens: 7 }),
      ]);

      const agents = createTranscriptSource(planDir, projectsRoot).read();

      expect(agents.map((a) => a.task)).toEqual(["work/01"]);
      expect(agents[0]!.counts.input).toBe(7);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a replaced file re-derives its identity instead of keeping the old one", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("m", { input_tokens: 100 }),
        assistant("m", { input_tokens: 100 }),
      ]);

      const source = createTranscriptSource(planDir, projectsRoot);
      expect(source.read()[0]).toMatchObject({ task: "work/01", role: "dev" });

      // Shorter content at the same path: a different agent, not more of the old one.
      jsonl(file, [
        announceUser(planDir, "ui/02", "judge", 3, "2026-01-01T00:09:00.000Z"),
      ]);

      expect(source.read()[0]).toMatchObject({
        task: "ui/02",
        role: "judge",
        attempt: 3,
        startedAt: "2026-01-01T00:09:00.000Z",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a replaced file belonging to another plan drops out of the results", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("m", { input_tokens: 100 }),
        assistant("m", { input_tokens: 100 }),
      ]);

      const source = createTranscriptSource(planDir, projectsRoot);
      expect(source.read()).toHaveLength(1);

      jsonl(file, [announceUser(`${planDir}-other`, "work/01", "dev", 1)]);

      expect(source.read()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a zero-byte transcript and a partial first line are both omitted until the opening line arrives", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const emptyFile = agentPath(projectsRoot, slug, "empty");
      mkdirSync(join(emptyFile, ".."), { recursive: true });
      writeFileSync(emptyFile, "");

      const partialFile = agentPath(projectsRoot, slug, "partial");
      mkdirSync(join(partialFile, ".."), { recursive: true });
      const fullLine = JSON.stringify(
        announceUser(planDir, "work/02", "dev", 1),
      );
      writeFileSync(partialFile, fullLine.slice(0, fullLine.length - 5));

      const source = createTranscriptSource(planDir, projectsRoot);
      expect(source.read()).toEqual([]);

      // Complete the partial line.
      writeFileSync(partialFile, fullLine + "\n");
      const agents = source.read();
      expect(agents).toHaveLength(1);
      expect(agents[0]!.task).toBe("work/02");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a started line with no message key does not throw, and a malformed line is skipped", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      mkdirSync(join(file, ".."), { recursive: true });
      const lines = [
        JSON.stringify(announceUser(planDir, "work/01", "dev", 1)),
        JSON.stringify({ type: "started", agentId: "x" }), // no `message` key
        "{not valid json",
        JSON.stringify(assistant("m", { input_tokens: 42 })),
      ];
      writeFileSync(file, lines.join("\n") + "\n");

      const source = createTranscriptSource(planDir, projectsRoot);
      const agents = source.read();
      expect(agents).toHaveLength(1);
      expect(agents[0]!.counts.input).toBe(42);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a deleted file is absent from the next result and its tokens leave the totals", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("m", { input_tokens: 50 }),
      ]);

      const source = createTranscriptSource(planDir, projectsRoot);
      expect(source.read()).toHaveLength(1);

      rmSync(file);
      expect(source.read()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a file that exists but throws on read keeps its previous counts unchanged", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("m", { input_tokens: 77 }),
      ]);

      const source = createTranscriptSource(planDir, projectsRoot);
      const first = source.read();
      expect(first[0]!.counts.input).toBe(77);

      // Replace the file with a directory of the same name: readSync on a directory
      // fd throws EISDIR, giving a reliable "exists but unreadable" without relying
      // on permission bits (which root or some CI users bypass entirely).
      rmSync(file);
      mkdirSync(file);

      const second = source.read();
      expect(second).toHaveLength(1);
      expect(second[0]!.counts.input).toBe(77);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("chmod-based unreadable file also keeps its previous state (skipped as root)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("m", { input_tokens: 11 }),
      ]);

      const source = createTranscriptSource(planDir, projectsRoot);
      const first = source.read();
      expect(first[0]!.counts.input).toBe(11);

      chmodSync(file, 0o000);
      try {
        const second = source.read();
        expect(second[0]!.counts.input).toBe(11);
      } finally {
        chmodSync(file, 0o644);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("multiple models are collected in first-seen order, deduplicated", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        assistant("model-a", { input_tokens: 1 }),
        assistant("model-b", { input_tokens: 1 }),
        assistant("model-a", { input_tokens: 1 }),
        assistant(undefined, { input_tokens: 1 }), // no model key: usage kept, model skipped
      ]);

      const source = createTranscriptSource(planDir, projectsRoot);
      const agents = source.read();
      expect(agents[0]!.models).toEqual(["model-a", "model-b"]);
      expect(agents[0]!.counts.input).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Claude Code writes one assistant line per streamed block, each carrying a
// progressively completed copy of the SAME request's usage. Measured over 842 real
// workflow transcripts: 88% of requests repeat, summing them overcounts cache reads
// 2.05x, and output_tokens never decreased across a request's snapshots.
describe("createTranscriptSource — billing dedup", () => {
  function setup(): {
    root: string;
    planDir: string;
    projectsRoot: string;
    slug: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "usage-source-dedup-"));
    const repoRoot = join(root, "repo");
    const planDir = join(repoRoot, "docs", "myplan");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), "gitdir: x\n");
    return {
      root,
      planDir,
      projectsRoot: join(root, "projects"),
      slug: projectSlug(repoRoot),
    };
  }

  test("counts one request once, keeping its last (complete) snapshot", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      jsonl(agentPath(projectsRoot, slug, "a"), [
        announceUser(planDir, "work/01", "dev", 1),
        snapshot("req_1", "msg_1", {
          input_tokens: 10,
          output_tokens: 1,
          cache_creation_input_tokens: 23331,
        }),
        snapshot("req_1", "msg_1", {
          input_tokens: 10,
          output_tokens: 1,
          cache_creation_input_tokens: 23331,
        }),
        snapshot("req_1", "msg_1", {
          input_tokens: 10,
          output_tokens: 341,
          cache_creation_input_tokens: 23331,
        }),
      ]);

      const agents = createTranscriptSource(planDir, projectsRoot).read();
      expect(agents[0]!.counts).toEqual({
        input: 10,
        output: 341,
        cacheRead: 0,
        cacheWrite: 23331,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps distinct requests separate", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      jsonl(agentPath(projectsRoot, slug, "a"), [
        announceUser(planDir, "work/01", "dev", 1),
        snapshot("req_1", "msg_1", { input_tokens: 10, output_tokens: 5 }),
        snapshot("req_2", "msg_2", { input_tokens: 20, output_tokens: 7 }),
      ]);

      const agents = createTranscriptSource(planDir, projectsRoot).read();
      expect(agents[0]!.counts).toMatchObject({ input: 30, output: 12 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The snapshots of one request routinely straddle a tail boundary, so the
  // dedup state has to outlive a single read() or the second half double-bills.
  test("dedups across an incremental read", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      const file = agentPath(projectsRoot, slug, "a");
      jsonl(file, [
        announceUser(planDir, "work/01", "dev", 1),
        snapshot("req_1", "msg_1", { input_tokens: 10, output_tokens: 1 }),
      ]);
      const source = createTranscriptSource(planDir, projectsRoot);
      expect(source.read()[0]!.counts).toMatchObject({ input: 10, output: 1 });

      appendJsonl(file, [
        snapshot("req_1", "msg_1", { input_tokens: 10, output_tokens: 341 }),
      ]);
      expect(source.read()[0]!.counts).toMatchObject({
        input: 10,
        output: 341,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Without a per-line fallback key every unkeyed line collapses onto one entry
  // and only the last would count.
  test("falls back to the uuid, then to a per-line key, when unkeyed", () => {
    const { root, planDir, projectsRoot, slug } = setup();
    try {
      jsonl(agentPath(projectsRoot, slug, "a"), [
        announceUser(planDir, "work/01", "dev", 1),
        {
          type: "assistant",
          uuid: "u1",
          message: { usage: { input_tokens: 3 } },
        },
        {
          type: "assistant",
          uuid: "u1",
          message: { usage: { input_tokens: 3 } },
        },
        { type: "assistant", message: { usage: { input_tokens: 4 } } },
        { type: "assistant", message: { usage: { input_tokens: 5 } } },
      ]);

      const agents = createTranscriptSource(planDir, projectsRoot).read();
      expect(agents[0]!.counts).toMatchObject({ input: 12 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("usage-fixture round trip", () => {
  test("createTranscriptSource reproduces the fixture's declared totals and agentCount", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-fixture-rt-"));
    try {
      const { planDir, projectsRoot, expected } = buildFixture(dir);
      const source = createTranscriptSource(planDir, projectsRoot);
      const agents = source.read();

      expect(agents).toHaveLength(expected.agentCount);

      const totals: TokenCounts = emptyCounts();
      for (const agent of agents) {
        totals.input += agent.counts.input;
        totals.output += agent.counts.output;
        totals.cacheRead += agent.counts.cacheRead;
        totals.cacheWrite += agent.counts.cacheWrite;
      }
      expect(totals).toEqual(expected.totals);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
