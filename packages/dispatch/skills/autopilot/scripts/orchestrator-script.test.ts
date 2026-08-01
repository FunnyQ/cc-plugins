/**
 * Deterministic fixture for the canonical orchestrator script.
 *
 * The script lives in `references/orchestrator.md` as a fenced JS block, because
 * the Workflow runtime takes it as source — it cannot import a module. So this
 * test extracts that exact block and runs it with stubbed `agent` / `parallel` /
 * `log` / `phase`. No agent is spawned and no file is touched; what is under
 * test is the wave loop's termination and reconciliation logic, which is where
 * a lost result turns into a run that looks clean.
 *
 * Keep the stubs faithful to the real runtime contract:
 *   - `agent()` returns null on a terminal failure; it does not throw.
 *   - `parallel()` resolves a thrown thunk to null; the call itself never rejects.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ORCHESTRATOR = join(
  import.meta.dir,
  "..",
  "references",
  "orchestrator.md",
);

type Counts = {
  total: number;
  todo: number;
  inProgress: number;
  done: number;
  blocked: number;
  invalid: number;
};

type ScoutResult = {
  stdout: string;
  exitCode: number;
  stderr: string;
} | null;

const snapshot = (tree: object, exitCode = 0): ScoutResult => ({
  stdout: JSON.stringify({
    ready: [],
    unfinished: [],
    invalid: [],
    errors: [],
    ...tree,
  }),
  exitCode,
  stderr: "",
});

type RunResult = {
  slug: string;
  completed: string[];
  escalations: {
    task: string;
    attempt: number;
    infrastructure?: boolean;
    parked?: boolean;
    reason: string;
  }[];
};

type Scenario = {
  /** One entry per wave, consumed in order. */
  scouts: ScoutResult[];
  commit?: (
    | { committed: boolean; shas: string[]; failed: boolean; reason: string }
    | null
  )[];
  /** Keyed by task ref; null models an agent that returned no structured result. */
  gate?: Record<string, ({ passed: boolean; summary: string } | null)[]>;
  judge?: Record<string, ({ verdict: Verdict; rationale: string } | null)[]>;
  markDone?: Record<
    string,
    ({ ok: boolean; status: string; error?: string } | null)[]
  >;
  /** Keyed by ref; models a park that reports failure, or returns nothing at all. */
  park?: Record<
    string,
    ({ ok: boolean; status: string; error?: string } | null)[]
  >;
  /** Refs whose dev step throws, simulating a pipeline that dies mid-flight. */
  devThrows?: string[];
};

type Verdict = {
  weighted: number;
  passed: boolean;
  hardFailed: boolean;
  missing: string[];
};

const pass: Verdict = {
  weighted: 4.6,
  passed: true,
  hardFailed: false,
  missing: [],
};
const fail: Verdict = {
  weighted: 2.1,
  passed: false,
  hardFailed: false,
  missing: [],
};

const ready = (ref: string, finalReview = false) => ({
  ref,
  finalReview,
  path: `/abs/repo/docs/my-plan/tasks/${ref}.md`,
});

/** Pull the canonical script out of the markdown, ready for `new Function`. */
type ConfigOverrides = Record<string, string>;

async function loadScript(overrides: ConfigOverrides = {}): Promise<string> {
  const doc = await readFile(ORCHESTRATOR, "utf-8");
  const start = doc.indexOf("```javascript");
  if (start === -1)
    throw new Error("no ```javascript block in orchestrator.md");
  const bodyStart = doc.indexOf("\n", start) + 1;
  const end = doc.indexOf("\n```", bodyStart);
  if (end === -1) throw new Error("unterminated ```javascript block");
  let script = doc.slice(bodyStart, end);
  for (const [field, literal] of Object.entries(overrides)) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^(\\s*${escaped}:\\s*)[^,\\n]+(,.*)$`, "m");
    if (!pattern.test(script)) {
      throw new Error(`config field not found in orchestrator script: ${field}`);
    }
    script = script.replace(pattern, `$1${literal}$2`);
  }
  // `export` is invalid inside a Function body; the runtime hoists meta itself.
  return script.replace(/^export const meta/m, "const meta");
}

type RunLog = {
  result: RunResult;
  /** Every agent label, in call order. */
  labels: string[];
  /** Every agent prompt, in call order. */
  prompts: string[];
  /** Every agent model, in call order. */
  models: (string | undefined)[];
};

async function runOrchestrator(
  scenario: Scenario,
  overrides: ConfigOverrides = {},
): Promise<RunLog> {
  const src = await loadScript(overrides);
  const labels: string[] = [];
  const prompts: string[] = [];
  const models: (string | undefined)[] = [];
  const scouts = [...scenario.scouts];
  const commits = [...(scenario.commit ?? [])];
  const queues = new Map<string, unknown[]>();
  const take = (bucket: string, ref: string, fallback: unknown) => {
    const key = `${bucket}:${ref}`;
    if (!queues.has(key)) {
      const source =
        (scenario[bucket as "gate" | "judge" | "markDone" | "park"] ?? {})[
          ref
        ] ?? undefined;
      queues.set(key, source ? [...source] : []);
    }
    const queue = queues.get(key)!;
    return queue.length > 0 ? queue.shift() : fallback;
  };

  const agent = async (
    prompt: string,
    opts: { label: string; model?: string },
  ) => {
    const label = opts.label;
    labels.push(label);
    prompts.push(prompt);
    models.push(opts.model);

    if (label.startsWith("scout-wave-")) {
      return scouts.length > 0 ? scouts.shift() : null;
    }
    if (label.startsWith("commit-")) {
      return commits.length > 0
        ? commits.shift()
        : { committed: true, shas: ["abc1234"], failed: false, reason: "" };
    }
    const [role, rest] = [label.slice(0, label.indexOf(":")), label];
    const refOf = (l: string) => l.slice(l.indexOf(":") + 1).split("#")[0];

    if (role === "verify") {
      return take("gate", refOf(rest), { passed: true, summary: "green" });
    }
    if (role === "judge") {
      return take("judge", refOf(rest), { verdict: pass, rationale: "solid" });
    }
    if (label.startsWith("done:")) {
      return take("markDone", refOf(rest), { ok: true, status: "done" });
    }
    if (label.startsWith("block:")) {
      return take("park", refOf(rest), { ok: true, status: "blocked" });
    }
    if (label.startsWith("dev:") || label.startsWith("dev-")) {
      const ref = refOf(rest);
      if (scenario.devThrows?.includes(ref)) {
        throw new Error(`dev exploded for ${ref}`);
      }
      return "implemented";
    }
    return "ok";
  };

  // Mirrors the runtime: a thrown thunk resolves to null, the call never rejects.
  const parallel = async (thunks: (() => Promise<unknown>)[]) =>
    Promise.all(
      thunks.map((thunk) =>
        Promise.resolve()
          .then(thunk)
          .catch(() => null),
      ),
    );

  const factory = new Function(
    "agent",
    "parallel",
    "log",
    "phase",
    `return (async () => {\n${src}\n})()`,
  );
  const result = (await factory(
    agent,
    parallel,
    () => {},
    () => {},
  )) as RunResult;
  return { result, labels, prompts, models };
}

const counts = (over: Partial<Counts> & { total: number }): Counts => ({
  todo: 0,
  inProgress: 0,
  done: 0,
  blocked: 0,
  invalid: 0,
  ...over,
});

/** The invariant the whole plan exists to protect. */
function accountsForEveryTask(result: RunResult, refs: string[]): boolean {
  return refs.every((ref) => {
    const inCompleted = result.completed.includes(ref);
    const inEscalations = result.escalations.some((e) => e.task === ref);
    return inCompleted !== inEscalations;
  });
}

function promptFor(log: Pick<RunLog, "labels" | "prompts">, label: string): string {
  const index = log.labels.indexOf(label);
  if (index === -1) throw new Error(`agent label not found: ${label}`);
  return log.prompts[index];
}

function modelFor(log: Pick<RunLog, "labels" | "models">, label: string) {
  const index = log.labels.indexOf(label);
  if (index === -1) throw new Error(`agent label not found: ${label}`);
  return log.models[index];
}

describe("orchestrator config fixture", () => {
  test("a config override throws when its field does not exist", async () => {
    await expect(loadScript({ missingField: "'codex'" })).rejects.toThrow(
      "config field not found in orchestrator script: missingField",
    );
  });
});

describe("orchestrator wave loop", () => {
  test("a fresh tree runs its ready task and finishes clean", async () => {
    const { result } = await runOrchestrator({
      scouts: [
        snapshot({
          ready: [ready("ui/01")],
          counts: counts({ total: 2, todo: 1, done: 1 }),
          unfinished: [{ ref: "ui/01", state: "todo" }],
          invalid: [],
        }),
        snapshot({
          ready: [],
          counts: counts({ total: 2, done: 2 }),
          unfinished: [],
          invalid: [],
        }),
      ],
    });
    expect(result.completed).toEqual(["ui/01"]);
    expect(result.escalations).toEqual([]);
  });

  test("a resumed tree counts earlier-run done tasks and does not false-stall", async () => {
    // Wave 2 shows done === total. `completed` holds only ui/03 — one entry for
    // a three-task tree — so a completed.length test would report a stall here.
    const { result } = await runOrchestrator({
      scouts: [
        snapshot({
          ready: [ready("ui/03")],
          counts: counts({ total: 3, todo: 1, done: 2 }),
          unfinished: [{ ref: "ui/03", state: "todo" }],
          invalid: [],
        }),
        snapshot({
          ready: [],
          counts: counts({ total: 3, done: 3 }),
          unfinished: [],
          invalid: [],
        }),
      ],
    });
    expect(result.completed).toEqual(["ui/03"]);
    expect(result.completed.length).not.toBe(3);
    expect(result.escalations).toEqual([]);
  });

  test("an empty ready set with unfinished tasks escalates as stalled", async () => {
    const { result } = await runOrchestrator({
      scouts: [
        snapshot({
          ready: [],
          counts: counts({ total: 3, inProgress: 1, blocked: 1, done: 1 }),
          unfinished: [
            { ref: "ui/01", state: "inProgress" },
            { ref: "ui/02", state: "blocked" },
          ],
          invalid: [],
        }),
      ],
    });
    expect(result.completed).toEqual([]);
    expect(result.escalations).toHaveLength(1);
    const [stall] = result.escalations;
    expect(stall.task).toBe("(tree)");
    expect(stall.reason).toMatch(/stalled/);
    expect(stall.reason).toContain("ui/01 (inProgress)");
    expect(stall.reason).toContain("ui/02 (blocked)");
    expect(stall.reason).toContain('"total":3');
  });

  test("an invalid tree is a scout failure naming the refs", async () => {
    const { result } = await runOrchestrator({
      scouts: [
        snapshot({
          ready: [ready("ui/02")],
          counts: counts({ total: 2, todo: 1, invalid: 1 }),
          unfinished: [{ ref: "ui/02", state: "todo" }],
          invalid: [{ ref: "ui/01", rule: "", reason: "" }],
        }),
      ],
    });
    expect(result.completed).toEqual([]);
    expect(result.escalations[0].task).toBe("(tree)");
    expect(result.escalations[0].reason).toContain("ui/01");
    expect(result.escalations[0].reason).toMatch(
      /do NOT tick the boxes by hand/i,
    );
  });

  test("counts that do not sum are a scout failure", async () => {
    const { result } = await runOrchestrator({
      scouts: [
        snapshot({
          ready: [ready("ui/01")],
          counts: {
            total: 5,
            todo: 1,
            inProgress: 0,
            done: 1,
            blocked: 0,
            invalid: 0,
          },
          unfinished: [{ ref: "ui/01", state: "todo" }],
          invalid: [],
        }),
      ],
    });
    expect(result.escalations[0].task).toBe("(scout)");
    expect(result.escalations[0].reason).toMatch(/do not add up/);
  });

  test("unparseable files escalate even when every PARSED task is done", async () => {
    // The trap: a file that fails to parse never enters byRef, so it never
    // enters counts either. counts reads done === total over a tree that still
    // holds a task nobody could read, and the run would report clean completion.
    const { result } = await runOrchestrator({
      scouts: [
        snapshot({
          ready: [],
          counts: counts({ total: 1, done: 1 }),
          unfinished: [],
          invalid: [],
          errors: [
            { file: "/abs/repo/.../ui/02-broken.md", reason: "missing H1" },
          ],
        }),
      ],
    });
    expect(result.completed).toEqual([]);
    expect(result.escalations).toHaveLength(1);
    const [esc] = result.escalations;
    expect(esc.task).toBe("(tree)");
    expect(esc.reason).toContain("did not parse");
    expect(esc.reason).toContain("02-broken.md");
    expect(esc.reason).toContain("missing H1");
  });

  test("a scout that returns nothing escalates instead of reading as drained", async () => {
    const { result } = await runOrchestrator({ scouts: [null] });
    expect(result.completed).toEqual([]);
    expect(result.escalations[0].task).toBe("(scout)");
    expect(result.escalations[0].infrastructure).toBe(true);
  });

  test("non-JSON scout stdout escalates instead of completing", async () => {
    const { result } = await runOrchestrator({
      scouts: [{ stdout: "not json", exitCode: 0, stderr: "" }],
    });
    expect(result.completed).toEqual([]);
    expect(result.escalations[0].task).toBe("(scout)");
    expect(result.escalations[0].reason).toMatch(/stdout was not JSON/);
  });

  test("a snapshot missing counts escalates with the field name", async () => {
    const { result } = await runOrchestrator({ scouts: [snapshot({})] });
    expect(result.completed).toEqual([]);
    expect(result.escalations[0].task).toBe("(scout)");
    expect(result.escalations[0].reason).toContain('"counts" is not an object');
  });

  test("an empty tree escalates before zero equals zero can complete", async () => {
    const { result } = await runOrchestrator({
      scouts: [snapshot({ counts: counts({ total: 0 }) })],
    });
    expect(result.completed).toEqual([]);
    expect(result.escalations[0].task).toBe("(tree)");
    expect(result.escalations[0].reason).toMatch(/contains no parseable tasks/);
  });

  test("a non-zero scout exit with valid JSON reaches the invalid-tree guard", async () => {
    const { result } = await runOrchestrator({
      scouts: [
        snapshot(
          {
            counts: counts({ total: 1, invalid: 1 }),
            unfinished: [{ ref: "ui/01", state: "invalid" }],
            invalid: [{ ref: "ui/01", rule: "", reason: "" }],
          },
          1,
        ),
      ],
    });
    expect(result.completed).toEqual([]);
    expect(result.escalations[0].task).toBe("(tree)");
    expect(result.escalations[0].reason).toContain("ui/01");
  });
});

describe("orchestrator failure handling", () => {
  const oneTask = (ref: string): ScoutResult => snapshot({
    ready: [ready(ref)],
    counts: counts({ total: 1, todo: 1 }),
    unfinished: [{ ref, state: "todo" }],
    invalid: [],
  });

  test("a null verifier is an infrastructure failure and dev is not rerun", async () => {
    const { result, labels } = await runOrchestrator({
      scouts: [oneTask("ui/01")],
      gate: { "ui/01": [null] },
    });
    expect(result.completed).toEqual([]);
    expect(result.escalations).toHaveLength(1);
    const [esc] = result.escalations;
    expect(esc.task).toBe("ui/01");
    expect(esc.infrastructure).toBe(true);
    expect(esc.attempt).toBe(1);
    expect(esc.parked).toBe(true);
    expect(esc.reason).toMatch(/verification did not run or did not return/);
    expect(esc.reason).toMatch(/no original cause/);
    // Exactly one dev attempt: an infrastructure failure never retries.
    expect(labels.filter((l) => l.startsWith("dev:"))).toHaveLength(1);
    expect(labels).toContain("block:ui/01");
  });

  test("a genuine failed verifier is a quality failure and DOES retry dev", async () => {
    const log = await runOrchestrator({
      scouts: [oneTask("ui/01")],
      gate: {
        "ui/01": [
          { passed: false, summary: "attempt one tests red" },
          { passed: false, summary: "attempt two lint red" },
          { passed: false, summary: "attempt three types red" },
        ],
      },
    });
    const { result, labels } = log;
    expect(labels.filter((l) => l.startsWith("dev:"))).toHaveLength(3);
    const firstPrompt = promptFor(log, "dev:ui/01#1");
    expect(firstPrompt).not.toContain("EARLIER ATTEMPTS");

    const thirdPrompt = promptFor(log, "dev:ui/01#3");
    expect(thirdPrompt).toContain(
      "Binary gate failed (verification/acceptance):\nattempt two lint red",
    );
    expect(thirdPrompt).toContain(
      "EARLIER ATTEMPTS on this task — already tried and rejected. Do not repeat them:",
    );
    expect(thirdPrompt).toContain(
      "- attempt 1 (ran on sonnet): Binary gate failed (verification/acceptance):\nattempt one tests red",
    );
    expect(thirdPrompt.indexOf("attempt two lint red")).toBeLessThan(
      thirdPrompt.indexOf("attempt one tests red"),
    );
    expect(thirdPrompt.match(/The previous attempt was rejected:/g)).toHaveLength(1);

    const [esc] = result.escalations;
    expect(esc.infrastructure).toBe(false);
    expect(esc.attempt).toBe(3);
    expect(esc.reason).toContain(
      "Binary gate failed (verification/acceptance):\nattempt three types red",
    );
    expect(esc.reason).toContain("attempt one tests red");
  });

  test("the default Claude ladder remains sonnet, sonnet, opus", async () => {
    const log = await runOrchestrator({
      scouts: [oneTask("ui/01")],
      gate: {
        "ui/01": [
          { passed: false, summary: "attempt one failed" },
          { passed: false, summary: "attempt two failed" },
          { passed: false, summary: "attempt three failed" },
        ],
      },
    });
    const devLabels = log.labels.filter((label) => label.startsWith("dev"));
    expect(devLabels).toEqual([
      "dev:ui/01#1",
      "dev:ui/01#2",
      "dev:ui/01#3",
    ]);
    expect(devLabels.map((label) => modelFor(log, label))).toEqual([
      "sonnet",
      "sonnet",
      "opus",
    ]);
    expect(log.result.escalations[0].attempt).toBe(3);
  });

  test("an opted-in vendor rung is appended after Claude Opus", async () => {
    const log = await runOrchestrator(
      {
        scouts: [oneTask("ui/01")],
        gate: {
          "ui/01": [
            { passed: false, summary: "attempt one failed" },
            { passed: false, summary: "attempt two failed" },
            { passed: false, summary: "attempt three failed" },
            { passed: false, summary: "attempt four failed" },
          ],
        },
      },
      { lastShotEngine: "'codex'" },
    );
    const devLabels = log.labels.filter((label) => label.startsWith("dev"));
    expect(devLabels).toEqual([
      "dev:ui/01#1",
      "dev:ui/01#2",
      "dev:ui/01#3",
      "dev-codex:ui/01#4",
    ]);
    expect(modelFor(log, "dev:ui/01#3")).toBe("opus");
    expect(modelFor(log, "dev-codex:ui/01#4")).toBe("haiku");
    expect(log.result.escalations[0].attempt).toBe(4);
  });

  test("an external dev engine keeps its existing ladder when lastShotEngine is set", async () => {
    const log = await runOrchestrator(
      {
        scouts: [oneTask("ui/01")],
        gate: {
          "ui/01": [
            { passed: false, summary: "attempt one failed" },
            { passed: false, summary: "attempt two failed" },
            { passed: false, summary: "attempt three failed" },
          ],
        },
      },
      { devEngine: "'codex'", lastShotEngine: "'opencode'" },
    );
    const devLabels = log.labels.filter((label) => label.startsWith("dev"));
    expect(devLabels).toEqual([
      "dev-codex:ui/01#1",
      "dev-codex:ui/01#2",
      "dev:ui/01#3",
    ]);
    expect(devLabels.map((label) => modelFor(log, label))).toEqual([
      "haiku",
      "haiku",
      "opus",
    ]);
    expect(log.result.escalations[0].attempt).toBe(3);
  });

  test("a one-attempt Claude ladder gets one Claude rung then the vendor rung", async () => {
    const log = await runOrchestrator(
      {
        scouts: [oneTask("ui/01")],
        gate: {
          "ui/01": [
            { passed: false, summary: "attempt one failed" },
            { passed: false, summary: "attempt two failed" },
          ],
        },
      },
      { maxAttempts: "1", lastShotEngine: "'codex'" },
    );
    expect(log.labels.filter((label) => label.startsWith("dev"))).toEqual([
      "dev:ui/01#1",
      "dev-codex:ui/01#2",
    ]);
    expect(log.result.escalations[0].attempt).toBe(2);
  });

  test("an unknown lastShotEngine fails at script start", async () => {
    await expect(
      runOrchestrator(
        { scouts: [oneTask("ui/01")] },
        { lastShotEngine: "'typo'" },
      ),
    ).rejects.toThrow('unknown engine "typo"');
  });

  test("a rubric retry preserves the exact veto and missing-dimension phrasing", async () => {
    const log = await runOrchestrator({
      scouts: [oneTask("ui/01")],
      judge: {
        "ui/01": [
          {
            verdict: {
              weighted: 2.1,
              passed: false,
              hardFailed: true,
              missing: ["efficiency", "style"],
            },
            rationale: "too slow and inconsistent",
          },
        ],
      },
    });
    const retryPrompt = promptFor(log, "dev:ui/01#2");
    expect(retryPrompt).toContain(
      "Rubric score 2.10 did not pass (hard-fail veto) (missing dims: efficiency, style):\ntoo slow and inconsistent",
    );
    expect(retryPrompt).not.toContain("EARLIER ATTEMPTS");
  });

  test("a closing-review retry labels its rejected round as final-review", async () => {
    const log = await runOrchestrator({
      scouts: [snapshot({
        ready: [ready("review/final", true)],
        counts: counts({ total: 1, todo: 1 }),
        unfinished: [{ ref: "review/final", state: "todo" }],
        invalid: [],
      })],
      gate: {
        "review/final": [
          { passed: false, summary: "integration command failed" },
          { passed: true, summary: "green" },
        ],
      },
    });
    const retryPrompt = promptFor(log, "fix:review/final#2");
    expect(retryPrompt).toContain(
      "Binary gate failed (verification/acceptance):\nintegration command failed",
    );
    expect(retryPrompt).toContain("previous round was rejected");

    const exhausted = await runOrchestrator({
      scouts: [snapshot({
        ready: [ready("review/final", true)],
        counts: counts({ total: 1, todo: 1 }),
        unfinished: [{ ref: "review/final", state: "todo" }],
        invalid: [],
      })],
      gate: {
        "review/final": [
          { passed: false, summary: "round one failed" },
          { passed: false, summary: "round two failed" },
        ],
      },
    });
    expect(exhausted.result.escalations[0].reason).toContain(
      "attempt 1 (ran on final-review)",
    );
  });

  test("a null judge is an infrastructure failure", async () => {
    const { result, labels } = await runOrchestrator({
      scouts: [oneTask("ui/01")],
      judge: { "ui/01": [null] },
    });
    const [esc] = result.escalations;
    expect(esc.infrastructure).toBe(true);
    expect(esc.reason).toMatch(/rubric judge returned no structured result/);
    expect(labels.filter((l) => l.startsWith("dev:"))).toHaveLength(1);
  });

  test("an unconfirmed mark-done parks instead of completing", async () => {
    const { result } = await runOrchestrator({
      scouts: [oneTask("ui/01")],
      markDone: {
        "ui/01": [
          { ok: false, status: "in-progress", error: "malformed header" },
        ],
      },
    });
    expect(result.completed).toEqual([]);
    const [esc] = result.escalations;
    expect(esc.infrastructure).toBe(true);
    expect(esc.reason).toMatch(
      /passed its rubric but mark-done did not confirm/,
    );
    expect(esc.reason).toContain("in-progress");
    expect(esc.reason).toContain("malformed header");
    expect(accountsForEveryTask(result, ["ui/01"])).toBe(true);
  });

  test("a park that does not confirm reports parked: false", async () => {
    // The agent answered, but the reread still shows in-progress. Reporting
    // parked: true here would hide the one instruction the user needs — reset
    // that Status by hand, because next-ready will never re-offer the task.
    const { result } = await runOrchestrator({
      scouts: [oneTask("ui/01")],
      gate: { "ui/01": [null] },
      park: {
        "ui/01": [
          { ok: false, status: "in-progress", error: "edit did not land" },
        ],
      },
    });
    const [esc] = result.escalations;
    expect(esc.task).toBe("ui/01");
    expect(esc.infrastructure).toBe(true);
    expect(esc.parked).toBe(false);
  });

  test("a park agent that returns nothing also reports parked: false", async () => {
    const { result } = await runOrchestrator({
      scouts: [oneTask("ui/01")],
      gate: { "ui/01": [null] },
      park: { "ui/01": [null] },
    });
    expect(result.escalations[0].parked).toBe(false);
  });

  test("a confirmed park reports parked: true", async () => {
    const { result } = await runOrchestrator({
      scouts: [oneTask("ui/01")],
      gate: { "ui/01": [null] },
      park: { "ui/01": [{ ok: true, status: "blocked" }] },
    });
    expect(result.escalations[0].parked).toBe(true);
  });

  test("a thrown task pipeline keeps the ref and the cause", async () => {
    const { result } = await runOrchestrator({
      scouts: [oneTask("ui/01")],
      devThrows: ["ui/01"],
    });
    const [esc] = result.escalations;
    expect(esc.task).toBe("ui/01");
    expect(esc.infrastructure).toBe(true);
    expect(esc.parked).toBe(true);
    expect(esc.reason).toMatch(/task pipeline threw: dev exploded for ui\/01/);
  });

  test("a wave where one task passes and one infrastructure-fails accounts for both", async () => {
    const { result } = await runOrchestrator({
      scouts: [
        snapshot({
          ready: [ready("ui/01"), ready("api/01")],
          counts: counts({ total: 2, todo: 2 }),
          unfinished: [
            { ref: "api/01", state: "todo" },
            { ref: "ui/01", state: "todo" },
          ],
          invalid: [],
        }),
        snapshot({
          ready: [],
          counts: counts({ total: 2, todo: 1, done: 1 }),
          unfinished: [{ ref: "api/01", state: "todo" }],
          invalid: [],
        }),
      ],
      gate: { "api/01": [null] },
    });
    expect(result.completed).toEqual(["ui/01"]);
    // api/01 was parked with its own escalation; the next wave's empty ready set
    // must NOT be re-reported as a fresh tree stall.
    expect(result.escalations.map((e) => e.task)).toEqual(["api/01"]);
    expect(accountsForEveryTask(result, ["ui/01", "api/01"])).toBe(true);
  });

  test("no incomplete task disappears from both completed and escalations", async () => {
    const refs = ["ui/01", "ui/02", "api/01"];
    const { result } = await runOrchestrator({
      scouts: [
        snapshot({
          ready: refs.map((r) => ready(r)),
          counts: counts({ total: 3, todo: 3 }),
          unfinished: refs.map((ref) => ({ ref, state: "todo" })),
          invalid: [],
        }),
        snapshot({
          ready: [],
          counts: counts({ total: 3, blocked: 2, done: 1 }),
          unfinished: [
            { ref: "api/01", state: "blocked" },
            { ref: "ui/02", state: "blocked" },
          ],
          invalid: [],
        }),
      ],
      gate: { "ui/02": [null] },
      devThrows: ["api/01"],
      judge: { "ui/01": [{ verdict: fail, rationale: "weak" }] },
    });
    expect(accountsForEveryTask(result, refs)).toBe(true);
    expect(result.escalations).toHaveLength(2);
  });
});

describe("orchestrator commits", () => {
  const wave = (ref: string, total: number, done: number): ScoutResult => snapshot({
    ready: [ready(ref)],
    counts: counts({ total, todo: total - done, done }),
    unfinished: [{ ref, state: "todo" }],
    invalid: [],
    errors: [],
  });
  const complete = (total: number): ScoutResult => snapshot({
    ready: [],
    counts: counts({ total, done: total }),
    unfinished: [],
    invalid: [],
    errors: [],
  });

  test("a failed inter-wave commit escalates without disturbing task accounting", async () => {
    const refs = ["ui/01", "ui/02"];
    const { result } = await runOrchestrator({
      scouts: [wave("ui/01", 2, 0), wave("ui/02", 2, 1), complete(2)],
      commit: [
        {
          committed: false,
          shas: [],
          failed: true,
          reason: "hook rejected commit",
        },
      ],
    });

    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0]).toMatchObject({
      task: "(commit)",
      attempt: 0,
      infrastructure: true,
      parked: false,
    });
    expect(result.escalations[0].reason).toContain("hook rejected commit");
    expect(accountsForEveryTask(result, refs)).toBe(true);
  });

  test("a null inter-wave commit escalates with an unknown outcome", async () => {
    const refs = ["ui/01", "ui/02"];
    const { result } = await runOrchestrator({
      scouts: [wave("ui/01", 2, 0), wave("ui/02", 2, 1), complete(2)],
      commit: [null],
    });

    expect(result.escalations[0]).toMatchObject({
      task: "(commit)",
      infrastructure: true,
      parked: false,
    });
    expect(result.escalations[0].reason).toMatch(/unknown/);
    expect(result.escalations[0].reason).not.toMatch(/commit failed/);
    expect(accountsForEveryTask(result, refs)).toBe(true);
  });

  test("an inter-wave commit runs after scout guards and before task dispatch", async () => {
    const { labels } = await runOrchestrator({
      scouts: [
        wave("ui/01", 2, 0),
        wave("ui/02", 2, 1),
        complete(2),
      ],
    });

    const scout = labels.indexOf("scout-wave-2");
    const commit = labels.indexOf("commit-wave-2");
    const dev = labels.findIndex(
      (label, index) => index > scout && label.startsWith("dev:"),
    );
    expect(commit).toBeGreaterThan(scout);
    expect(commit).toBeLessThan(dev);
  });

  test.each([
    {
      name: "parse errors",
      scout: snapshot({
        ready: [ready("ui/02")],
        counts: counts({ total: 1, todo: 1 }),
        unfinished: [{ ref: "ui/02", state: "todo" }],
        invalid: [],
        errors: [{ file: "ui/02.md", reason: "missing H1" }],
      }),
    },
    {
      name: "invalid counts",
      scout: snapshot({
        ready: [ready("ui/02")],
        counts: counts({ total: 1, invalid: 1 }),
        unfinished: [{ ref: "ui/02", state: "invalid" }],
        invalid: [{ ref: "ui/02", rule: "", reason: "" }],
        errors: [],
      }),
    },
  ])("a wave aborted by $name emits no commit label", async ({ scout }) => {
    const { labels } = await runOrchestrator({
      scouts: [wave("ui/01", 2, 0), scout],
    });
    expect(labels.some((label) => label.startsWith("commit-"))).toBe(false);
  });

  test("a completed wave skips inter-wave commit and only runs post-loop commit", async () => {
    const { labels } = await runOrchestrator({
      scouts: [
        wave("ui/01", 1, 0),
        complete(1),
      ],
    });

    expect(labels.filter((label) => label.startsWith("commit-wave-"))).toEqual([]);
    expect(labels.filter((label) => label === "commit-post-loop")).toHaveLength(1);
  });
});
