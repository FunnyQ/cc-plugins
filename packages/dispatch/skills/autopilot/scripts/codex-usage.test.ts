import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachCodexUsage,
  createCodexSource,
  discoverRollouts,
  mapCodexUsage,
} from "./codex-usage";
import type { AgentUsage } from "./usage-types";

function agent(overrides: Partial<AgentUsage> & { file: string }): AgentUsage {
  return {
    task: "work/01",
    role: "dev",
    attempt: 1,
    startedAt: "2026-08-29T08:00:00.000Z",
    lastAt: "2026-08-29T09:00:00.000Z",
    relayDirs: [],
    externalDriver: false,
    models: ["claude-haiku-4-5-20251001"],
    counts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000 },
    ...overrides,
  };
}

function writeRollout(root: string, name: string, lines: unknown[]): string {
  const dir = join(root, "2026", "08", "29");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const meta = (cwd: string, originator = "codex_exec") => ({
  timestamp: "2026-08-29T08:30:00.000Z",
  type: "session_meta",
  payload: { cwd, originator },
});

const tokenCount = (usage: Record<string, number>) => ({
  timestamp: "2026-08-29T08:31:00.000Z",
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: usage } },
});

const turnContext = (model: string) => ({
  timestamp: "2026-08-29T08:30:30.000Z",
  type: "turn_context",
  payload: { model },
});

// The real shape, from a rollout on disk. `input_tokens` already contains
// `cached_input_tokens`, and `total_tokens` is input+output — so a mapper that adds the
// fields it is handed reports roughly double what codex actually billed.
const REAL_USAGE = {
  input_tokens: 1_487_898,
  cached_input_tokens: 1_405_952,
  cache_write_input_tokens: 0,
  output_tokens: 7_766,
  reasoning_output_tokens: 1_877,
  total_tokens: 1_495_664,
};

describe("mapCodexUsage", () => {
  test("conserves codex's own total across the four counters", () => {
    const counts = mapCodexUsage(REAL_USAGE);
    expect(
      counts.input + counts.output + counts.cacheRead + counts.cacheWrite,
    ).toBe(REAL_USAGE.total_tokens);
  });

  test("treats cached input as a subset of input, not an addition to it", () => {
    const counts = mapCodexUsage(REAL_USAGE);
    expect(counts.cacheRead).toBe(1_405_952);
    expect(counts.cacheWrite).toBe(1_487_898 - 1_405_952);
  });

  test("does not give reasoning a counter of its own", () => {
    expect(mapCodexUsage(REAL_USAGE).output).toBe(7_766);
  });

  test("never reports a negative fresh count from an inconsistent snapshot", () => {
    const counts = mapCodexUsage({
      total_tokens: 10,
      output_tokens: 50,
      cached_input_tokens: 900,
    });
    expect(counts.cacheWrite).toBe(0);
  });

  test("reads a non-object as all zeroes rather than throwing", () => {
    expect(mapCodexUsage(null)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("discoverRollouts", () => {
  test("returns nothing for a sessions tree that does not exist", () => {
    expect(discoverRollouts(join(tmpdir(), "no-such-codex-root"))).toEqual([]);
  });

  test("finds rollouts under YYYY/MM/DD and ignores anything else there", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    const wanted = writeRollout(root, "rollout-a.jsonl", [meta("/repo")]);
    writeRollout(root, "notes.txt", [meta("/repo")]);
    expect(discoverRollouts(root)).toEqual([wanted]);
  });
});

describe("createCodexSource", () => {
  test("takes the LAST token_count, because codex restates the whole run each turn", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    writeRollout(root, "rollout-a.jsonl", [
      meta("/repo"),
      tokenCount({ input_tokens: 100, total_tokens: 100 }),
      tokenCount({ input_tokens: 300, total_tokens: 300 }),
    ]);

    const [run] = createCodexSource(root).read();
    expect(run!.counts.cacheWrite).toBe(300);
  });

  test("reads cwd, originator, and the relay directory off the rollout", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    writeRollout(root, "rollout-a.jsonl", [
      meta("/repo/app", "codex-tui"),
      {
        timestamp: "2026-08-29T08:31:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Read the file /tmp/relay/20260829-164034-617-28486-7d4298ab/live-prompt.md and follow it",
            },
          ],
        },
      },
    ]);

    const [run] = createCodexSource(root).read();
    expect(run!.cwd).toBe("/repo/app");
    expect(run!.originator).toBe("codex-tui");
    expect(run!.relayDir).toBe("20260829-164034-617-28486-7d4298ab");
  });

  test("reads the model off a turn_context payload, absent from session_meta", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    writeRollout(root, "rollout-a.jsonl", [
      meta("/repo"),
      turnContext("gpt-6-astra"),
    ]);

    const [run] = createCodexSource(root).read();
    expect(run!.model).toBe("gpt-6-astra");
  });

  test("has no model when the rollout carries no turn_context line", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    writeRollout(root, "rollout-a.jsonl", [meta("/repo")]);

    const [run] = createCodexSource(root).read();
    expect(run!.model).toBeNull();
  });

  test("a second pass over an unchanged tree reports the same totals", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    writeRollout(root, "rollout-a.jsonl", [
      meta("/repo"),
      tokenCount({ input_tokens: 500, total_tokens: 500 }),
    ]);

    const source = createCodexSource(root);
    expect(source.read()).toEqual(source.read());
  });

  test("a rollout truncated and rewritten under the same path keeps nothing of the old run", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    const file = writeRollout(root, "rollout-a.jsonl", [
      meta("/repo/app"),
      turnContext("gpt-6-astra"),
      { type: "x", text: "/tmp/relay/20260829-164034-617-28486-7d4298ab/p.md" },
    ]);
    const source = createCodexSource(root);
    source.read();

    writeFileSync(file, "{}\n");
    const [run] = source.read();
    expect(run!.cwd).toBeNull();
    expect(run!.startedAt).toBeNull();
    expect(run!.relayDir).toBeNull();
    expect(run!.originator).toBeNull();
    expect(run!.model).toBeNull();
  });

  test("a second read sees a rollout written after the first", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    const source = createCodexSource(root);
    expect(source.read()).toEqual([]);
    writeRollout(root, "rollout-a.jsonl", [meta("/repo")]);
    expect(source.read()).toHaveLength(1);
  });

  // Windows ignores chmod 0o000, so the file stays readable there.
  test.skipIf(process.platform === "win32")(
    "an unreadable pass keeps the last-known counts rather than zeroing them",
    () => {
      const root = mkdtempSync(join(tmpdir(), "codex-"));
      const file = writeRollout(root, "rollout-a.jsonl", [
        meta("/repo"),
        tokenCount({ input_tokens: 500, total_tokens: 500 }),
      ]);
      const source = createCodexSource(root);
      source.read();

      writeFileSync(file, "{}\n");
      chmodSync(file, 0o000);
      try {
        const [run] = source.read();
        expect(run!.counts.cacheWrite).toBe(500);
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );
});

describe("attachCodexUsage", () => {
  const run = (
    overrides: Partial<Parameters<typeof attachCodexUsage>[1][0]>,
  ) => ({
    file: "/rollout.jsonl",
    cwd: "/repo",
    startedAt: "2026-08-29T08:30:00.000Z",
    relayDir: null,
    originator: "codex_exec",
    model: null,
    counts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 5000 },
    ...overrides,
  });

  test("joins on the relay directory both sides name, whatever the run's cwd", () => {
    const agents = [
      agent({ file: "/a1.jsonl", relayDirs: ["dir-1"], externalDriver: true }),
      agent({ file: "/a2.jsonl", role: "judge" }),
    ];
    const [driver, judge] = attachCodexUsage(
      agents,
      [run({ relayDir: "dir-1", cwd: "/elsewhere" })],
      "/repo",
    );

    expect(driver!.codexCounts?.cacheWrite).toBe(5000);
    expect(judge!.codexCounts).toBeUndefined();
  });

  test("a non-driver running beside the user's own codex window absorbs none of its spend", () => {
    // The failure this guards: judge:foundation/02#1 absorbed 30,039 tokens from a
    // codex window the user had open in the same repo.
    const [judge] = attachCodexUsage(
      [agent({ file: "/judge.jsonl", role: "judge", externalDriver: false })],
      [run({})],
      "/repo",
    );
    expect(judge!.codexCounts).toBeUndefined();
  });

  test("a driver does claim a run inside its window", () => {
    const [driver] = attachCodexUsage(
      [agent({ file: "/a1.jsonl", externalDriver: true })],
      [run({})],
      "/repo",
    );
    expect(driver!.codexCounts?.cacheWrite).toBe(5000);
  });

  test("counts an interactive run too — both originators are eligible", () => {
    const [driver] = attachCodexUsage(
      [agent({ file: "/a1.jsonl", externalDriver: true })],
      [run({ originator: "codex-tui" })],
      "/repo",
    );
    expect(driver!.codexCounts?.cacheWrite).toBe(5000);
  });

  test("drops a run from outside the repo rather than spreading it over the plan", () => {
    const [driver] = attachCodexUsage(
      [agent({ file: "/a1.jsonl", externalDriver: true })],
      [run({ cwd: "/somewhere/else" })],
      "/repo",
    );
    expect(driver!.codexCounts).toBeUndefined();
  });

  test("drops a run that started outside every driver's window", () => {
    const [driver] = attachCodexUsage(
      [agent({ file: "/a1.jsonl", externalDriver: true })],
      [run({ startedAt: "2026-08-29T23:00:00.000Z" })],
      "/repo",
    );
    expect(driver!.codexCounts).toBeUndefined();
  });

  test("a driver still in flight claims a run that started after its last write", () => {
    const [driver] = attachCodexUsage(
      [agent({ file: "/a1.jsonl", externalDriver: true })],
      [run({ startedAt: "2026-08-29T09:30:00.000Z" })],
      "/repo",
      { openIdentities: new Set(["work/01|dev|1"]) },
    );
    expect(driver!.codexCounts?.cacheWrite).toBe(5000);
  });

  test("only the identities the flightlog reports open get the endless window", () => {
    const [driver] = attachCodexUsage(
      [agent({ file: "/a1.jsonl", externalDriver: true })],
      [run({ startedAt: "2026-08-29T09:30:00.000Z" })],
      "/repo",
      { openIdentities: new Set(["work/02|dev|1"]) },
    );
    expect(driver!.codexCounts).toBeUndefined();
  });

  test("two drivers in flight take one run each, nearest start first", () => {
    const agents = [
      agent({
        file: "/a1.jsonl",
        externalDriver: true,
        startedAt: "2026-08-29T08:00:00.000Z",
        lastAt: "2026-08-29T08:10:00.000Z",
      }),
      agent({
        file: "/a2.jsonl",
        task: "work/02",
        externalDriver: true,
        startedAt: "2026-08-29T08:20:00.000Z",
        lastAt: "2026-08-29T08:25:00.000Z",
      }),
    ];
    const attached = attachCodexUsage(
      agents,
      [
        run({ file: "/r1.jsonl", startedAt: "2026-08-29T08:30:00.000Z" }),
        run({ file: "/r2.jsonl", startedAt: "2026-08-29T08:31:00.000Z" }),
      ],
      "/repo",
      { openIdentities: new Set(["work/01|dev|1", "work/02|dev|1"]) },
    );
    expect(attached[1]!.codexCounts?.cacheWrite).toBe(5000);
    expect(attached[0]!.codexCounts?.cacheWrite).toBe(5000);
  });

  test("one driver takes at most one run by window, so two cannot double-bill it", () => {
    const agents = [
      agent({ file: "/a1.jsonl", externalDriver: true }),
      agent({ file: "/a2.jsonl", externalDriver: true, attempt: 2 }),
    ];
    const attached = attachCodexUsage(
      agents,
      [run({ file: "/r1.jsonl" }), run({ file: "/r2.jsonl" })],
      "/repo",
    );
    expect(attached[0]!.codexCounts?.cacheWrite).toBe(5000);
    expect(attached[1]!.codexCounts?.cacheWrite).toBe(5000);
  });

  test("accumulates several relay delegations onto the one driver that made them", () => {
    const attached = attachCodexUsage(
      [
        agent({
          file: "/a1.jsonl",
          relayDirs: ["dir-1", "dir-2"],
          externalDriver: true,
        }),
      ],
      [run({ relayDir: "dir-1" }), run({ relayDir: "dir-2" })],
      "/repo",
    );
    expect(attached[0]!.codexCounts?.cacheWrite).toBe(10_000);
  });

  test("a relay directory two agents name goes to the first, which created it", () => {
    const attached = attachCodexUsage(
      [
        agent({
          file: "/a1.jsonl",
          relayDirs: ["dir-1"],
          externalDriver: true,
        }),
        agent({
          file: "/a2.jsonl",
          relayDirs: ["dir-1"],
          externalDriver: true,
        }),
      ],
      [run({ relayDir: "dir-1" })],
      "/repo",
    );
    expect(attached[0]!.codexCounts?.cacheWrite).toBe(5000);
    expect(attached[1]!.codexCounts).toBeUndefined();
  });

  test("equal start distances go to the lower file path, whatever the input order", () => {
    const low = agent({ file: "/a1.jsonl", externalDriver: true });
    const high = agent({ file: "/a2.jsonl", externalDriver: true, attempt: 2 });
    for (const agents of [
      [low, high],
      [high, low],
    ]) {
      const attached = attachCodexUsage(agents, [run({})], "/repo");
      const winner = attached.find((a) => a.codexCounts !== undefined);
      expect(winner!.file).toBe("/a1.jsonl");
    }
  });

  test("an agent that drove no codex run carries no codexCounts or codexModels, never a zeroed or empty one", () => {
    const [judge] = attachCodexUsage(
      [agent({ file: "/judge.jsonl", role: "judge" })],
      [],
      "/repo",
    );
    expect("codexCounts" in judge!).toBe(false);
    expect("codexModels" in judge!).toBe(false);
  });

  test("keeps codex spend out of the driver's Claude counts, so one merged figure never hides which side burned what", () => {
    const agents = [agent({ file: "/a1.jsonl", externalDriver: true })];
    const [driver] = attachCodexUsage(agents, [run({})], "/repo");

    expect(driver!.counts.cacheWrite).toBe(1000);
    expect(agents[0]!.codexCounts).toBeUndefined(); // input not mutated
  });

  test("carries a run's model onto the driver's codexModels", () => {
    const [driver] = attachCodexUsage(
      [agent({ file: "/a1.jsonl", externalDriver: true })],
      [run({ model: "gpt-6-astra" })],
      "/repo",
    );
    expect(driver!.codexModels).toEqual(["gpt-6-astra"]);
  });

  test("dedupes and preserves first-seen order across several codex runs", () => {
    const attached = attachCodexUsage(
      [
        agent({
          file: "/a1.jsonl",
          relayDirs: ["dir-1", "dir-2", "dir-3"],
          externalDriver: true,
        }),
      ],
      [
        run({ relayDir: "dir-1", model: "gpt-6-astra" }),
        run({ relayDir: "dir-2", model: "gpt-5" }),
        run({ relayDir: "dir-3", model: "gpt-6-astra" }),
      ],
      "/repo",
    );
    expect(attached[0]!.codexModels).toEqual(["gpt-6-astra", "gpt-5"]);
  });

  test("a run with no model leaves codexModels absent, never an empty array", () => {
    const [driver] = attachCodexUsage(
      [agent({ file: "/a1.jsonl", externalDriver: true })],
      [run({})],
      "/repo",
    );
    expect(driver!.codexModels).toBeUndefined();
  });
});
