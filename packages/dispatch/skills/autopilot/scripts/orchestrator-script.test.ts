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
 *   - `agent()` returns null on a terminal API failure.
 *   - `agent({schema})` THROWS when the subagent never calls StructuredOutput —
 *     it does not return null, so a null-guard alone never sees that failure.
 *     Model it with the THROWS sentinel.
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

/**
 * The stubbed agent throws on this sentinel instead of returning. It models the
 * one failure a null-guard cannot see: a subagent that text-emits
 * `<StructuredOutput>…</StructuredOutput>` rather than calling the tool, which
 * makes the real `agent({schema})` reject.
 */
const THROWS = "__throws__" as const;
type Throws = typeof THROWS;

const NO_STRUCTURED_OUTPUT =
  "agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)";

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
  /** One entry per wave, consumed in order. THROWS models a rejecting agent. */
  scouts: (ScoutResult | Throws)[];
  /** Omit to leave the Workflow runtime's `budget` global undeclared. */
  budget?: { total: number | null; spent: number; spendAfterDev?: number };
  commit?: (
    | {
        committed: boolean;
        shas: string[];
        failed: boolean;
        reason: string;
      }
    | Throws
    | null
  )[];
  /** Keyed by task ref; null models an agent that returned no structured result. */
  gate?: Record<
    string,
    ({ passed: boolean; deferred?: boolean; summary: string } | Throws | null)[]
  >;
  requalify?: Record<
    string,
    ({ passed: boolean; deferred?: boolean; summary: string } | Throws | null)[]
  >;
  judge?: Record<
    string,
    ({ verdict: Verdict; rationale: string } | Throws | null)[]
  >;
  markDone?: Record<
    string,
    ({ ok: boolean; status: string; error?: string } | Throws | null)[]
  >;
  /** Keyed by ref; models a park that reports failure, or returns nothing at all. */
  park?: Record<
    string,
    ({ ok: boolean; status: string; error?: string } | Throws | null)[]
  >;
  /** Refs whose dev step throws, simulating a pipeline that dies mid-flight. */
  devThrows?: string[];
  /** Keyed by ref; the stubbed dev step awaits this before returning. */
  devHolds?: Record<string, Promise<void>>;
  /** Keyed by ref; the stubbed park agent awaits this before returning. */
  parkHolds?: Record<string, Promise<void>>;
  /** Keyed by ref; the stubbed mark-done agent awaits this before returning. */
  doneHolds?: Record<string, Promise<void>>;
  /** Optional live call sink for tests that coordinate held writer windows. */
  agentCalls?: string[];
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
      throw new Error(
        `config field not found in orchestrator script: ${field}`,
      );
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
  let budgetSpent = scenario.budget?.spent ?? 0;
  const scouts = [...scenario.scouts];
  const commits = [...(scenario.commit ?? [])];
  const queues = new Map<string, unknown[]>();
  const take = (bucket: string, ref: string, fallback: unknown) => {
    const key = `${bucket}:${ref}`;
    if (!queues.has(key)) {
      const source =
        (scenario[
          bucket as "gate" | "requalify" | "judge" | "markDone" | "park"
        ] ?? {})[ref] ?? undefined;
      queues.set(key, source ? [...source] : []);
    }
    const queue = queues.get(key)!;
    const next = queue.length > 0 ? queue.shift() : fallback;
    // Faithful to the runtime at EVERY schema'd call, not just the scout and the
    // commit agents: queue THROWS to model a subagent that text-emits its payload.
    if (next === THROWS) throw new Error(NO_STRUCTURED_OUTPUT);
    return next;
  };

  const agent = async (
    prompt: string,
    opts: { label: string; model?: string },
  ) => {
    const label = opts.label;
    labels.push(label);
    scenario.agentCalls?.push(label);
    prompts.push(prompt);
    models.push(opts.model);

    if (label.startsWith("scout-wave-")) {
      const next = scouts.length > 0 ? scouts.shift() : null;
      if (next === THROWS) throw new Error(NO_STRUCTURED_OUTPUT);
      return next;
    }
    if (label.startsWith("commit-")) {
      const next =
        commits.length > 0
          ? commits.shift()
          : { committed: true, shas: ["abc1234"], failed: false, reason: "" };
      if (next === THROWS) throw new Error(NO_STRUCTURED_OUTPUT);
      return next;
    }
    const [role, rest] = [label.slice(0, label.indexOf(":")), label];
    const refOf = (l: string) => l.slice(l.indexOf(":") + 1).split("#")[0];

    if (role === "verify") {
      return take("gate", refOf(rest), { passed: true, summary: "green" });
    }
    if (role === "requalify") {
      return take("requalify", refOf(rest), {
        passed: true,
        summary: "green after quiet",
      });
    }
    if (role === "judge") {
      return take("judge", refOf(rest), { verdict: pass, rationale: "solid" });
    }
    if (label.startsWith("done:")) {
      const ref = refOf(rest);
      if (scenario.doneHolds?.[ref]) {
        await scenario.doneHolds[ref];
      }
      return take("markDone", ref, { ok: true, status: "done" });
    }
    if (label.startsWith("block:")) {
      const ref = refOf(rest);
      if (scenario.parkHolds?.[ref]) {
        await scenario.parkHolds[ref];
      }
      return take("park", ref, { ok: true, status: "blocked" });
    }
    if (label.startsWith("dev:") || label.startsWith("dev-")) {
      const ref = refOf(rest);
      if (scenario.devHolds?.[ref]) {
        await scenario.devHolds[ref];
      }
      if (scenario.budget?.spendAfterDev !== undefined) {
        budgetSpent = scenario.budget.spendAfterDev;
      }
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

  const parameterNames = ["agent", "parallel", "log", "phase"];
  const parameterValues: unknown[] = [agent, parallel, () => {}, () => {}];
  if (scenario.budget) {
    const { total } = scenario.budget;
    parameterNames.push("budget");
    parameterValues.push({
      total,
      remaining: () => (total === null ? 0 : total - budgetSpent),
    });
  }
  const factory = new Function(
    ...parameterNames,
    `return (async () => {\n${src}\n})()`,
  );
  const result = (await factory(...parameterValues)) as RunResult;
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

/** One wave offering `ref` as the only ready task in a tree of `total`. */
const wave = (ref: string, total: number, done: number): ScoutResult =>
  snapshot({
    ready: [ready(ref)],
    counts: counts({ total, todo: total - done, done }),
    unfinished: [{ ref, state: "todo" }],
  });

/** One wave offering every ref in `refs` as ready, in a tree of exactly those. */
const multiWave = (refs: string[]): ScoutResult =>
  snapshot({
    ready: refs.map((ref) => ready(ref)),
    counts: counts({ total: refs.length, todo: refs.length }),
    unfinished: refs.map((ref) => ({ ref, state: "todo" })),
  });

/** The scout every finished run ends on: nothing ready, everything done. */
const complete = (total: number): ScoutResult =>
  snapshot({
    ready: [],
    counts: counts({ total, done: total }),
    unfinished: [],
  });

/** The invariant the whole plan exists to protect. */
function accountsForEveryTask(result: RunResult, refs: string[]): boolean {
  return refs.every((ref) => {
    const inCompleted = result.completed.includes(ref);
    const inEscalations = result.escalations.some((e) => e.task === ref);
    return inCompleted !== inEscalations;
  });
}

function promptFor(
  log: Pick<RunLog, "labels" | "prompts">,
  label: string,
): string {
  const index = log.labels.indexOf(label);
  if (index === -1) throw new Error(`agent label not found: ${label}`);
  return log.prompts[index];
}

function modelFor(log: Pick<RunLog, "labels" | "models">, label: string) {
  const index = log.labels.indexOf(label);
  if (index === -1) throw new Error(`agent label not found: ${label}`);
  return log.models[index];
}

/**
 * A promise a test releases by hand, to hold a stubbed agent inside its window.
 * Replaces the `let releaseX!: () => void` idiom at every hold site.
 */
const latch = () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  return { held, release };
};

async function waitForCall(calls: string[], label: string): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (calls.includes(label)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`agent call did not arrive: ${label}`);
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

  test("a task rolled back after passing escalates as divergence, naming the ref", async () => {
    // Wave 1 passes ui/01 and ui/02. Wave 2's disk snapshot has only ui/01 done:
    // something rewrote ui/02's task file after mark-done confirmed it, so the
    // scout still lists ui/02 as todo. `completed` and `unfinished` now overlap.
    // Note counts.done (1) is BELOW completed.length (2) here, but the check is
    // the intersection — see the resume test above, where the counts point the
    // other way and nothing must fire.
    const { result } = await runOrchestrator({
      scouts: [
        snapshot({
          ready: [ready("ui/01"), ready("ui/02")],
          counts: counts({ total: 3, todo: 3 }),
          unfinished: [
            { ref: "ui/01", state: "todo" },
            { ref: "ui/02", state: "todo" },
            { ref: "ui/03", state: "todo" },
          ],
          invalid: [],
        }),
        snapshot({
          ready: [ready("ui/02"), ready("ui/03")],
          counts: counts({ total: 3, todo: 2, done: 1 }),
          unfinished: [
            { ref: "ui/02", state: "todo" },
            { ref: "ui/03", state: "todo" },
          ],
          invalid: [],
        }),
      ],
    });
    expect(result.completed).toEqual(["ui/01", "ui/02"]);
    expect(result.escalations).toHaveLength(1);
    const [divergence] = result.escalations;
    expect(divergence.task).toBe("(divergence)");
    expect(divergence.infrastructure).toBe(true);
    expect(divergence.reason).toMatch(/divergence/);
    expect(divergence.reason).toContain("ui/02");
    // The untouched sibling must not be blamed.
    expect(divergence.reason).not.toContain("ui/03");
    // It must NOT be reported as a stall — that is the wrong cause.
    expect(divergence.reason).not.toMatch(/stalled/);
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

  // The failure a null-guard cannot see. `agent({schema})` rejects when the
  // subagent text-emits its payload instead of calling StructuredOutput, so an
  // unguarded scout call takes the whole run down with it — and every finished
  // wave's `completed` and `escalations` die with the throw, leaving the tree
  // reading `done` on disk while the run reports nothing at all.
  // Two throws, because the first one is retried; see "structured-output
  // resilience" for the retry itself.
  test("a scout that throws twice escalates instead of killing the run", async () => {
    const { result } = await runOrchestrator({ scouts: [THROWS, THROWS] });
    expect(result.completed).toEqual([]);
    expect(result.escalations[0].task).toBe("(scout)");
    expect(result.escalations[0].infrastructure).toBe(true);
    expect(result.escalations[0].reason).toMatch(/StructuredOutput/);
  });

  test("a mid-run scout throw keeps the waves that already finished", async () => {
    const { result } = await runOrchestrator({
      scouts: [wave("ui/01", 2, 0), THROWS, THROWS],
    });
    expect(result.completed).toEqual(["ui/01"]);
    expect(result.escalations[0].task).toBe("(scout)");
    expect(result.escalations[0].reason).toMatch(/wave 2/);
  });

  test("non-JSON scout stdout escalates instead of completing", async () => {
    const { result } = await runOrchestrator({
      scouts: [{ stdout: "not json", exitCode: 0, stderr: "" }],
    });
    expect(result.completed).toEqual([]);
    expect(result.escalations[0].task).toBe("(scout)");
    expect(result.escalations[0].reason).toMatch(/stdout was not JSON/);
  });

  // A primitive parses fine, so only a shape test catches it. `null` and `0` are
  // also falsy, so a truthiness guard would skip validation entirely and let the
  // first field read throw past the (scout) escalation.
  test.each([
    ["null", "null"],
    ["0", "number"],
    ['"done"', "string"],
    ["[]", "an array"],
  ])(
    "scout stdout %s escalates as a non-object shape",
    async (stdout, shape) => {
      const { result } = await runOrchestrator({
        scouts: [{ stdout, exitCode: 0, stderr: "" }],
      });
      expect(result.completed).toEqual([]);
      expect(result.escalations).toHaveLength(1);
      expect(result.escalations[0].task).toBe("(scout)");
      expect(result.escalations[0].infrastructure).toBe(true);
      expect(result.escalations[0].reason).toContain(`parsed to ${shape}`);
    },
  );

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

describe("orchestrator budget floor", () => {
  const pendingWave = () =>
    snapshot({
      ready: [ready("api/01"), ready("ui/02")],
      counts: counts({ total: 3, todo: 2, done: 1 }),
      unfinished: [
        { ref: "api/01", state: "todo" },
        { ref: "ui/02", state: "todo" },
      ],
      invalid: [],
    });

  test("stops before dispatch with one synthetic escalation and a complete reason", async () => {
    const { result, labels } = await runOrchestrator(
      { scouts: [pendingWave()], budget: { total: 100, spent: 91 } },
      { budgetFloor: "10" },
    );

    expect(result.completed).toEqual([]);
    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0]).toMatchObject({
      task: "(budget)",
      attempt: 0,
      infrastructure: true,
      parked: false,
    });
    expect(result.escalations[0].reason).toContain(
      "9 of 100 output tokens remain",
    );
    expect(result.escalations[0].reason).toContain("configured floor of 10");
    expect(result.escalations[0].reason).toContain(
      "Not dispatched: api/01, ui/02",
    );
    expect(result.escalations[0].reason).toContain(
      "2 of 3 task(s) remain unfinished",
    );
    expect(labels.some((label) => label.startsWith("dev:"))).toBe(false);
    expect(
      labels.some((label) => /^(verify|judge|done|block):/.test(label)),
    ).toBe(false);
  });

  test("commits the completed wave before stopping the next dispatch", async () => {
    const { result, labels } = await runOrchestrator(
      {
        scouts: [
          snapshot({
            ready: [ready("api/01")],
            counts: counts({ total: 2, todo: 2 }),
            unfinished: [
              { ref: "api/01", state: "todo" },
              { ref: "ui/02", state: "todo" },
            ],
            invalid: [],
          }),
          snapshot({
            ready: [ready("ui/02")],
            counts: counts({ total: 2, todo: 1, done: 1 }),
            unfinished: [{ ref: "ui/02", state: "todo" }],
            invalid: [],
          }),
        ],
        budget: { total: 100, spent: 0, spendAfterDev: 95 },
      },
      { budgetFloor: "10" },
    );

    expect(result.completed).toEqual(["api/01"]);
    expect(result.escalations.map((item) => item.task)).toEqual(["(budget)"]);
    expect(labels).toContain("commit-wave-2");
    expect(labels.indexOf("commit-wave-2")).toBeGreaterThan(
      labels.indexOf("done:api/01"),
    );
    expect(labels.some((label) => label.startsWith("dev:ui/02"))).toBe(false);
  });

  test("the default zero floor leaves a nearly exhausted run unchanged", async () => {
    const { result } = await runOrchestrator({
      scouts: [wave("ui/01", 1, 0), complete(1)],
      budget: { total: 1, spent: 1 },
    });

    expect(result.completed).toEqual(["ui/01"]);
    expect(result.escalations.some((item) => item.task === "(budget)")).toBe(
      false,
    );
  });

  test("a null total never trips a configured floor", async () => {
    const { result } = await runOrchestrator(
      {
        scouts: [wave("ui/01", 1, 0), complete(1)],
        budget: { total: null, spent: 999 },
      },
      { budgetFloor: "1000000" },
    );

    expect(result.completed).toEqual(["ui/01"]);
    expect(result.escalations.some((item) => item.task === "(budget)")).toBe(
      false,
    );
  });

  test("an absent budget global does not throw or stop dispatch", async () => {
    const { result } = await runOrchestrator(
      {
        scouts: [wave("ui/01", 1, 0), complete(1)],
      },
      { budgetFloor: "10" },
    );

    expect(result.completed).toEqual(["ui/01"]);
    expect(result.escalations.some((item) => item.task === "(budget)")).toBe(
      false,
    );
  });

  test("normalizes negative and fractional floors", async () => {
    for (const budgetFloor of ["-5", "10.9"]) {
      const { result } = await runOrchestrator(
        {
          scouts: [wave("ui/01", 1, 0), complete(1)],
          budget: { total: 100, spent: 90 },
        },
        { budgetFloor },
      );
      expect(result.completed).toEqual(["ui/01"]);
      expect(result.escalations.some((item) => item.task === "(budget)")).toBe(
        false,
      );
    }
  });
});

describe("orchestrator failure handling", () => {
  const oneTask = (ref: string): ScoutResult => wave(ref, 1, 0);

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
    expect(
      thirdPrompt.match(/The previous attempt was rejected:/g),
    ).toHaveLength(1);

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
    expect(devLabels).toEqual(["dev:ui/01#1", "dev:ui/01#2", "dev:ui/01#3"]);
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
      scouts: [
        snapshot({
          ready: [ready("review/final", true)],
          counts: counts({ total: 1, todo: 1 }),
          unfinished: [{ ref: "review/final", state: "todo" }],
          invalid: [],
        }),
      ],
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
      scouts: [
        snapshot({
          ready: [ready("review/final", true)],
          counts: counts({ total: 1, todo: 1 }),
          unfinished: [{ ref: "review/final", state: "todo" }],
          invalid: [],
        }),
      ],
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

  test("a commit agent that throws escalates like a null one", async () => {
    const refs = ["ui/01", "ui/02"];
    const { result } = await runOrchestrator({
      scouts: [wave("ui/01", 2, 0), wave("ui/02", 2, 1), complete(2)],
      commit: [THROWS],
    });

    expect(result.escalations[0]).toMatchObject({
      task: "(commit)",
      infrastructure: true,
      parked: false,
    });
    expect(result.escalations[0].reason).toMatch(/StructuredOutput/);
    expect(accountsForEveryTask(result, refs)).toBe(true);
  });

  test("an inter-wave commit runs after scout guards and before task dispatch", async () => {
    const { labels } = await runOrchestrator({
      scouts: [wave("ui/01", 2, 0), wave("ui/02", 2, 1), complete(2)],
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
      scouts: [wave("ui/01", 1, 0), complete(1)],
    });

    expect(labels.filter((label) => label.startsWith("commit-wave-"))).toEqual(
      [],
    );
    expect(labels.filter((label) => label === "commit-post-loop")).toHaveLength(
      1,
    );
  });
});

describe("orchestrator cross-vendor review lens", () => {
  /** One wave offering only the Final review task, then a drained tree. */
  const finalWave: ScoutResult = snapshot({
    ready: [ready("integration/01", true)],
    counts: counts({ total: 1, todo: 1 }),
    unfinished: [{ ref: "integration/01", state: "todo" }],
  });

  const reviewPrompt = async (overrides: ConfigOverrides = {}) => {
    const log = await runOrchestrator(
      { scouts: [finalWave, complete(1)] },
      overrides,
    );
    return promptFor(log, "review:codex#1");
  };

  test("defaults to the headless wrapper", async () => {
    const prompt = await reviewPrompt();

    expect(prompt).toContain("codex-run.ts review");
    expect(prompt).not.toContain("relay.ts");
  });

  test("runs through relay in a live pane when live review is on", async () => {
    const prompt = await reviewPrompt({
      liveReviewEngine: "true",
      relayPath: "'/abs/relay/relay.ts'",
    });

    expect(prompt).toContain("bun /abs/relay/relay.ts codex review");
    expect(prompt).toContain("--wait-timeout 480000");
    expect(prompt).not.toContain("codex-run.ts review");
  });

  test("auto-approves so an approval prompt cannot stall an unattended run", async () => {
    const prompt = await reviewPrompt({
      liveReviewEngine: "true",
      relayPath: "'/abs/relay/relay.ts'",
    });

    expect(prompt).toContain("--dangerous");
  });

  test("keeps waiting through relay collect instead of failing a pending review", async () => {
    const prompt = await reviewPrompt({
      liveReviewEngine: "true",
      relayPath: "'/abs/relay/relay.ts'",
      liveCollectRounds: "2",
    });

    expect(prompt).toContain(
      "relay ... collect --agent <name> --result <path>",
    );
    expect(prompt).toContain("at most 2 times");
  });

  test("falls back to headless when relayPath did not resolve", async () => {
    const prompt = await reviewPrompt({ liveReviewEngine: "true" });

    expect(prompt).toContain("codex-run.ts review");
    expect(prompt).not.toContain("relay.ts");
  });

  test("the three Claude lenses stay headless whatever the review engine does", async () => {
    const log = await runOrchestrator(
      { scouts: [finalWave, complete(1)] },
      { liveReviewEngine: "true", relayPath: "'/abs/relay/relay.ts'" },
    );

    for (const lens of ["reuse", "leanness", "efficiency"]) {
      expect(promptFor(log, `review:${lens}#1`)).not.toContain("relay.ts");
    }
  });

  /**
   * Pins the lens SET, not just each member. The loop above passes even if a
   * removed lens is reintroduced, so it cannot protect the 4→3 consolidation
   * that replaced `simplification` + `altitude` with `leanness`.
   */
  test("fans out exactly the external lens plus reuse / leanness / efficiency", async () => {
    const log = await runOrchestrator({ scouts: [finalWave, complete(1)] });

    const lenses = log.labels
      .filter((label) => label.startsWith("review:"))
      .map((label) => label.slice("review:".length).split("#")[0])
      .sort();

    expect(lenses).toEqual(["codex", "efficiency", "leanness", "reuse"]);
  });

  test("leanness carries the tag vocabulary and the net-lines summary", async () => {
    const log = await runOrchestrator({ scouts: [finalWave, complete(1)] });
    const prompt = promptFor(log, "review:leanness#1");

    for (const tag of ["delete:", "stdlib:", "native:", "yagni:", "shrink:"]) {
      expect(prompt).toContain(tag);
    }
    expect(prompt).toContain("net: -<N> lines possible.");
    // Correctness/security/perf belong to other lenses; overlap wastes a pass.
    expect(prompt).toContain("OUT of scope");
  });

  test("reuse owns the under-engineering half that altitude used to carry", async () => {
    const log = await runOrchestrator({ scouts: [finalWave, complete(1)] });

    expect(promptFor(log, "review:reuse#1")).toContain(
      "copy-paste that wants a helper",
    );
  });

  /**
   * The exclusivity rule is scoped to the abstraction axis on purpose: an
   * efficiency fix may legitimately add a cache or a batch, and a blanket
   * "every other lens only cuts" once gave the fixer grounds to reject one.
   */
  test("the fixer is told not to reject an efficiency finding for adding code", async () => {
    const log = await runOrchestrator({ scouts: [finalWave, complete(1)] });
    const prompt = promptFor(log, "fix:integration/01#1");

    expect(prompt).toContain("ABSTRACTION axis");
    expect(prompt).toContain(
      "never reject an efficiency finding merely because it adds code",
    );
  });
});

describe("orchestrator commit ownership", () => {
  const BAN = "Never run `git commit`";
  const RESTORE_BAN = "do not reason your way past this one";

  const devWave: ScoutResult = snapshot({
    ready: [ready("ui/01")],
    counts: counts({ total: 2, todo: 2 }),
    unfinished: [
      { ref: "ui/01", state: "todo" },
      { ref: "review/01", state: "todo" },
    ],
  });

  const finalWave: ScoutResult = snapshot({
    ready: [ready("review/01", true)],
    counts: counts({ total: 2, todo: 1, done: 1 }),
    unfinished: [{ ref: "review/01", state: "todo" }],
  });

  test("the Claude dev step is told never to commit", async () => {
    const log = await runOrchestrator({ scouts: [devWave, complete(2)] });

    expect(promptFor(log, "dev:ui/01#1")).toContain(BAN);
    expect(promptFor(log, "dev:ui/01#1")).toContain(RESTORE_BAN);
    expect(promptFor(log, "verify:ui/01#1")).toContain(RESTORE_BAN);
    expect(promptFor(log, "judge:ui/01#1")).toContain(RESTORE_BAN);
  });

  test("the external dev driver is told never to commit", async () => {
    const log = await runOrchestrator(
      { scouts: [devWave, complete(2)] },
      { devEngine: "'codex'" },
    );

    expect(promptFor(log, "dev-codex:ui/01#1")).toContain(BAN);
    expect(promptFor(log, "dev-codex:ui/01#1")).toContain(RESTORE_BAN);
  });

  test("the external driver passes the ban on to the CLI it drives", async () => {
    const log = await runOrchestrator(
      { scouts: [devWave, complete(2)] },
      { devEngine: "'codex'" },
    );
    const prompt = promptFor(log, "dev-codex:ui/01#1");

    expect(prompt).toContain("Include the no-commit rule in that instruction");
  });

  test("the driver may not author the implementation it delegates", async () => {
    const log = await runOrchestrator(
      { scouts: [devWave, complete(2)] },
      { devEngine: "'codex'" },
    );
    const prompt = promptFor(log, "dev-codex:ui/01#1");

    expect(prompt).toContain("INSTRUCTION SHAPE");
    expect(prompt).toContain("no ready-to-paste source");
  });

  test("the driver may not soften a gate on the way to the CLI", async () => {
    const log = await runOrchestrator(
      { scouts: [devWave, complete(2)] },
      { devEngine: "'codex'" },
    );
    const prompt = promptFor(log, "dev-codex:ui/01#1");

    expect(prompt).toContain("never tell codex to skip one");
    expect(prompt).toContain("A gate you believe is wrong is a plan defect");
  });

  // The independent verifier runs the same commands moments later and owns the
  // verdict, the driver's return value is discarded, and the driver has no lever
  // to act on red output — so a driver that verifies only doubles a full suite
  // run and sits a cheap model in front of failures it cannot answer. The lint
  // is NOT duplicated: the external engine writes outside the harness, so the
  // Edit/Write lint hook never saw the task file it left behind.
  test("the driver lints the task file but does not run its verification", async () => {
    const log = await runOrchestrator(
      { scouts: [devWave, complete(2)] },
      { devEngine: "'codex'" },
    );
    const prompt = promptFor(log, "dev-codex:ui/01#1");

    expect(prompt).toContain("lint-task.ts");
    expect(prompt).toContain("Do NOT run the task's ## Verification commands");
    expect(prompt).not.toContain("Verification commands YOURSELF");
  });

  // Rejection feedback names what failed, and a driver left to "fold it in"
  // freely reads that as permission to route around it — dropping the failing
  // command and telling the delegate the previous code was already correct.
  test("retry feedback may only add requirements, never subtract a gate", async () => {
    const log = await runOrchestrator(
      {
        scouts: [wave("ui/01", 1, 0)],
        gate: { "ui/01": [{ passed: false, summary: "swagger not staged" }] },
      },
      { devEngine: "'codex'" },
    );
    const retryPrompt = promptFor(log, "dev-codex:ui/01#2");

    expect(retryPrompt).toContain("swagger not staged");
    expect(retryPrompt).toContain("Feedback may only ADD requirements");
    expect(retryPrompt).toContain("may never subtract a verification command");
  });

  test("the final-review fixer is told never to commit", async () => {
    const log = await runOrchestrator({ scouts: [finalWave, complete(2)] });

    expect(promptFor(log, "fix:review/01#1")).toContain(BAN);
    expect(promptFor(log, "fix:review/01#1")).toContain(RESTORE_BAN);
    expect(promptFor(log, "review:codex#1")).toContain(RESTORE_BAN);
    expect(promptFor(log, "review:codex#1")).toContain(
      "Include the restore-family ban in that instruction",
    );
  });

  test("the commit agents are the exception and still commit", async () => {
    const log = await runOrchestrator({ scouts: [devWave, complete(2)] });

    expect(promptFor(log, "commit-post-loop")).toContain("git commit");
    expect(promptFor(log, "commit-post-loop")).not.toContain(BAN);
    expect(promptFor(log, "commit-post-loop")).toContain(RESTORE_BAN);
  });
});

describe("held-back paths", () => {
  // A parked task used to disable every later commit, leaving the whole tree
  // dirty for the rest of the run. Now only its own paths are held back.
  test("a parked task holds back its own path and no longer blocks the commit", async () => {
    const log = await runOrchestrator({
      scouts: [
        snapshot({
          ready: [ready("ui/01"), ready("ui/02")],
          counts: counts({ total: 3, todo: 3 }),
          unfinished: [
            { ref: "ui/01", state: "todo" },
            { ref: "ui/02", state: "todo" },
            { ref: "ui/03", state: "todo" },
          ],
        }),
        snapshot({
          ready: [ready("ui/03")],
          counts: counts({ total: 3, done: 1, blocked: 1, todo: 1 }),
          unfinished: [{ ref: "ui/03", state: "todo" }],
        }),
        snapshot({
          counts: counts({ total: 3, done: 2, blocked: 1 }),
          unfinished: [{ ref: "ui/02", state: "blocked" }],
        }),
      ],
      gate: {
        "ui/02": [
          { passed: false, summary: "one" },
          { passed: false, summary: "two" },
          { passed: false, summary: "three" },
        ],
      },
    });

    expect(log.labels).toContain("commit-wave-2");
    const prompt = promptFor(log, "commit-wave-2");
    expect(prompt).toContain("/abs/repo/docs/my-plan/tasks/ui/02.md");
    expect(prompt).toContain("Files to create / modify");
    expect(prompt).not.toContain("/abs/repo/docs/my-plan/tasks/ui/01.md");
  });

  test("a clean wave carries no held-back block", async () => {
    const log = await runOrchestrator({
      scouts: [wave("ui/01", 2, 0), wave("ui/02", 2, 1)],
    });
    expect(promptFor(log, "commit-wave-2")).not.toContain("HELD BACK");
  });
});

describe("defer and requalify gate", () => {
  const siblingMarker = "SUSPECTED SIBLING INTERFERENCE";
  const twoTaskScouts = () => [
    multiWave(["ui/main", "ui/sibling"]),
    complete(2),
  ];

  test("a deferred failure passes after one requalify without rerunning dev", async () => {
    const sibling = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [
          {
            passed: false,
            deferred: true,
            summary: `${siblingMarker}: test exited 1`,
          },
        ],
      },
      requalify: { "ui/main": [{ passed: true, summary: "test exited 0" }] },
      devHolds: { "ui/sibling": sibling.held },
      agentCalls: calls,
    });

    await waitForCall(calls, "verify:ui/main#1");
    expect(calls).not.toContain("requalify:ui/main#1");
    sibling.release();
    const { result, labels } = await run;

    expect(result.completed).toEqual(["ui/main", "ui/sibling"]);
    expect(labels.filter((label) => label === "dev:ui/main#1")).toHaveLength(1);
    expect(
      labels.filter((label) => label.startsWith("requalify:ui/main")),
    ).toEqual(["requalify:ui/main#1"]);
  });

  test("a failing requalify falls through to the next dev attempt", async () => {
    const sibling = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [
          {
            passed: false,
            deferred: true,
            summary: `${siblingMarker}: test exited 1`,
          },
          { passed: true, summary: "retry passed" },
        ],
      },
      requalify: { "ui/main": [{ passed: false, summary: "still red" }] },
      devHolds: { "ui/sibling": sibling.held },
      agentCalls: calls,
    });

    await waitForCall(calls, "verify:ui/main#1");
    sibling.release();
    const { result, labels } = await run;

    expect(result.completed).toContain("ui/main");
    expect(labels).toContain("requalify:ui/main#1");
    expect(labels).toContain("dev:ui/main#2");
    expect(labels).not.toContain("requalify:ui/main#2");
  });

  test("requalify waits for a sibling held inside mark-done", async () => {
    const mainDev = latch();
    const done = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [
          {
            passed: false,
            deferred: true,
            summary: `${siblingMarker}: test exited 1`,
          },
        ],
      },
      devHolds: { "ui/main": mainDev.held },
      doneHolds: { "ui/sibling": done.held },
      agentCalls: calls,
    });

    await waitForCall(calls, "done:ui/sibling");
    mainDev.release();
    await waitForCall(calls, "verify:ui/main#1");
    expect(calls).not.toContain("requalify:ui/main#1");
    done.release();
    const { labels } = await run;
    expect(labels.indexOf("requalify:ui/main#1")).toBeGreaterThan(
      labels.indexOf("done:ui/sibling"),
    );
  });

  test("passed=true rejects deferral", async () => {
    const { labels, result } = await runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [{ passed: true, deferred: true, summary: siblingMarker }],
      },
    });
    expect(result.completed).toContain("ui/main");
    expect(labels.some((label) => label.startsWith("requalify:"))).toBe(false);
  });

  test("a one-task wave rejects deferral", async () => {
    const { labels } = await runOrchestrator({
      scouts: [wave("ui/main", 1, 0), complete(1)],
      gate: {
        "ui/main": [
          { passed: false, deferred: true, summary: siblingMarker },
          { passed: true, summary: "retry passed" },
        ],
      },
    });
    expect(labels).toContain("dev:ui/main#2");
    expect(labels.some((label) => label.startsWith("requalify:"))).toBe(false);
  });

  test("a missing sibling marker rejects deferral", async () => {
    // The sibling is held so a live writer DOES exist when the gate returns.
    // Without that hold this test would pass with the marker check deleted — the
    // live-writer condition alone would reject the deferral, making it a copy of
    // "no live sibling writer rejects deferral" below. The absent marker has to
    // be the only failing condition for this test to mean anything.
    const sibling = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [
          { passed: false, deferred: true, summary: "error: something else" },
          { passed: true, summary: "retry passed" },
        ],
      },
      devHolds: { "ui/sibling": sibling.held },
      agentCalls: calls,
    });

    await waitForCall(calls, "verify:ui/main#1");
    sibling.release();
    const { labels } = await run;

    expect(labels).toContain("dev:ui/main#2");
    expect(labels.some((label) => label.startsWith("requalify:"))).toBe(false);
  });

  test("no live sibling writer rejects deferral", async () => {
    const { labels } = await runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [
          { passed: false, deferred: true, summary: siblingMarker },
          { passed: true, summary: "retry passed" },
        ],
      },
    });
    expect(labels).toContain("dev:ui/main#2");
    expect(labels.some((label) => label.startsWith("requalify:"))).toBe(false);
  });

  test("a deferred flag from requalify is ignored", async () => {
    const sibling = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [
          { passed: false, deferred: true, summary: siblingMarker },
          { passed: true, summary: "retry passed" },
        ],
      },
      requalify: {
        "ui/main": [{ passed: false, deferred: true, summary: siblingMarker }],
      },
      devHolds: { "ui/sibling": sibling.held },
      agentCalls: calls,
    });
    await waitForCall(calls, "verify:ui/main#1");
    sibling.release();
    const { labels } = await run;
    expect(
      labels.filter((label) => label.startsWith("requalify:ui/main")),
    ).toEqual(["requalify:ui/main#1"]);
    expect(labels).toContain("dev:ui/main#2");
  });

  test("when every task defers the last request is rejected and the wave settles", async () => {
    const refs = ["ui/01", "ui/02", "ui/03"];
    const { result, labels } = await runOrchestrator({
      scouts: [multiWave(refs), complete(3)],
      gate: Object.fromEntries(
        refs.map((ref) => [
          ref,
          [
            { passed: false, deferred: true, summary: siblingMarker },
            { passed: true, summary: "retry passed" },
          ],
        ]),
      ),
    });
    expect(result.completed).toEqual(refs);
    expect(
      labels.filter((label) => label.startsWith("requalify:")),
    ).toHaveLength(2);
    expect(
      labels.filter(
        (label) => label.endsWith("#2") && label.startsWith("dev:"),
      ),
    ).toHaveLength(1);
  });

  test("requalify waits for a sibling held inside catch-path park", async () => {
    const mainDev = latch();
    const park = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [{ passed: false, deferred: true, summary: siblingMarker }],
      },
      devThrows: ["ui/sibling"],
      devHolds: { "ui/main": mainDev.held },
      parkHolds: { "ui/sibling": park.held },
      agentCalls: calls,
    });
    await waitForCall(calls, "block:ui/sibling");
    mainDev.release();
    await waitForCall(calls, "verify:ui/main#1");
    expect(calls).not.toContain("requalify:ui/main#1");
    park.release();
    const { result, labels } = await run;
    expect(labels.indexOf("requalify:ui/main#1")).toBeGreaterThan(
      labels.indexOf("block:ui/sibling"),
    );
    expect(result.escalations.some((item) => item.task === "ui/sibling")).toBe(
      true,
    );
  });

  test("a null requalify result is an infrastructure failure", async () => {
    const sibling = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [{ passed: false, deferred: true, summary: siblingMarker }],
      },
      requalify: { "ui/main": [null] },
      devHolds: { "ui/sibling": sibling.held },
      agentCalls: calls,
    });
    await waitForCall(calls, "verify:ui/main#1");
    sibling.release();
    const { result, labels } = await run;
    const failure = result.escalations.find((item) => item.task === "ui/main");
    expect(labels).toContain("requalify:ui/main#1");
    expect(failure?.infrastructure).toBe(true);
    expect(failure?.attempt).toBe(1);
    expect(failure?.reason).toMatch(/requalification did not run/);
  });

  test("verify prompts keep PASS or FAIL logging and switch role by mode", async () => {
    const sibling = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [{ passed: false, deferred: true, summary: siblingMarker }],
      },
      devHolds: { "ui/sibling": sibling.held },
      agentCalls: calls,
    });
    await waitForCall(calls, "verify:ui/main#1");
    sibling.release();
    const log = await run;
    const normal = promptFor(log, "verify:ui/main#1");
    const requalify = promptFor(log, "requalify:ui/main#1");
    expect(normal).toContain("--role verify");
    expect(normal).toContain(siblingMarker);
    expect(requalify).toContain("--role requalify");
    expect(requalify).toContain("deferred is ignored");
    expect(normal).toContain(
      "message MUST start with the bare word PASS or FAIL",
    );
    expect(requalify).toContain(
      "message MUST start with the bare word PASS or FAIL",
    );
  });

  test("both verifier modes keep the strict-exit rule and the restore ban", async () => {
    // The two modes render from one builder but through different closing text,
    // so a later edit can drop a clause from one and leave the other intact.
    // Both are captured here; the ban assertions make requalify the EIGHTH
    // rendered capture, alongside the seven in "orchestrator commit ownership".
    const sibling = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [{ passed: false, deferred: true, summary: siblingMarker }],
      },
      devHolds: { "ui/sibling": sibling.held },
      agentCalls: calls,
    });
    await waitForCall(calls, "verify:ui/main#1");
    sibling.release();
    const log = await run;
    const normal = promptFor(log, "verify:ui/main#1");
    const requalify = promptFor(log, "requalify:ui/main#1");

    for (const mode of [normal, requalify]) {
      expect(mode).toContain("Any non-zero exit is passed=false");
      expect(mode).toContain("do not reason your way past this one");
      // A waiver clause is the defect the whole plan exists to prevent: the
      // incident that motivated it ended with a verifier passing two red tests
      // on its own sibling-attribution. Any hedge near the exit rule is a
      // finding, so the rendered text may carry none of these words at all.
      expect(mode).not.toMatch(
        /unless|except|may still pass|can be ignored|disregard/i,
      );
    }

    // Mode-specific halves: neither may leak into the other.
    expect(normal).toContain(
      "An unsupported deferral is counted as a plain failure",
    );
    expect(requalify).not.toContain(siblingMarker);
    expect(requalify).toContain("The sibling explanation no longer applies");
    expect(normal).not.toContain("deferred is ignored");
  });
});

// WRITER ACCOUNTING TESTS
// ══════════════════════════════════════════════════════════════════════════
// What these tests deliberately cannot prove, and why:
// - The count has no observable effect until something waits on it, and nothing
//   here waits. A test that releases a held dev promise only proves the agent
//   finished; a test that observes the park's label only proves the park ran,
//   which is equally true with the wrapper removed. So the accounting — that
//   dev, mark-done and the catch-path park each open a counted window — is only
//   testable through a consumer that waits on the quiet signal. That consumer
//   now exists: the "defer and requalify gate" suite above holds a sibling in
//   dev, in mark-done, and in the catch-path park, and asserts the requalify
//   agent does not run until the hold is released. The accounting is asserted
//   there, not here.
//
// What these tests do own: the threading is correct, the wrapping does not
// disturb a normal wave, and the run's shape is unchanged. Note that a
// miscounted latch presents to the defer suite as a **hang** rather than a
// failure — so a timeout in that suite is a real defect and must never be
// "fixed" by raising the limit.
test("the watch does not disturb a normal wave", async () => {
  // A multi-task wave with no holds completes with the same completed set and
  // the same agent-label order as before the watch existed.
  const { result, labels } = await runOrchestrator({
    scouts: [multiWave(["ui/01", "ui/02"]), complete(2)],
  });
  expect(result.completed).toEqual(["ui/01", "ui/02"]);
  expect(result.escalations).toEqual([]);
  // The agent sequence is unchanged by the watch: dev, verify, judge, done for
  // each task, in any order (parallel tasks in wave 1, then the next wave).
  const waveOneDev = labels.filter(
    (l) => l.startsWith("dev") && l.includes("#1"),
  ).length;
  const waveOneVerify = labels.filter(
    (l) => l.startsWith("verify") && l.includes("#1"),
  ).length;
  expect(waveOneDev).toBe(2);
  expect(waveOneVerify).toBe(2);
});

test("a wave whose every dev step is held, then released, completes", async () => {
  // All holds are released after the wave is known to be in flight. This proves
  // the wrapping does not change when a wave finishes. It is NOT a deadlock test:
  // nothing in this task awaits quiet(), so completion depends only on the holds
  // being released, and this would still pass if leave() never decremented. Leak
  // detection belongs to the capability that waits — do not claim it here.
  const devUI01 = latch();
  const devUI02 = latch();

  const run = runOrchestrator({
    scouts: [multiWave(["ui/01", "ui/02"]), complete(2)],
    devHolds: {
      "ui/01": devUI01.held,
      "ui/02": devUI02.held,
    },
  });

  await Promise.resolve();
  devUI01.release();
  devUI02.release();
  const { result } = await run;

  expect(result.completed).toEqual(["ui/01", "ui/02"]);
  expect(result.escalations).toEqual([]);
});

test("a held catch-path park still reconciles", async () => {
  // Hold a sibling's dev step so it throws into the guarded wrapper's catch,
  // hold its park, release both, and assert the task is escalated and parked
  // exactly as it is today. This proves the extra wrapping did not break the
  // catch path; it does NOT prove the park is counted.
  const dev = latch();
  const park = latch();

  const run = runOrchestrator({
    scouts: [multiWave(["ui/01", "ui/02"]), complete(2)],
    devThrows: ["ui/01"],
    devHolds: { "ui/01": dev.held },
    parkHolds: { "ui/01": park.held },
  });

  await Promise.resolve();
  dev.release();
  await Promise.resolve();
  park.release();
  const { result } = await run;

  expect(result.completed).toEqual(["ui/02"]);
  expect(result.escalations).toHaveLength(1);
  const [escalation] = result.escalations;
  expect(escalation.task).toBe("ui/01");
  expect(escalation.parked).toBe(true);
});

// STRUCTURED-OUTPUT RESILIENCE
// ══════════════════════════════════════════════════════════════════════════
// A schema'd agent that text-emits its payload has usually already done all of
// the real work — the live case wrote a green PASS row to the flightlog first.
// Catching the throw records that failure; only a retry recovers from it. What
// these tests pin is that the retry happens exactly once, on the intended model,
// at every idempotent call site — and at no other.
const callsTo = (labels: string[], label: string) =>
  labels.filter((seen) => seen === label).length;

/** Every model a given label ran on, in call order. */
const modelsFor = (log: Pick<RunLog, "labels" | "models">, label: string) =>
  log.labels.flatMap((seen, index) =>
    seen === label ? [log.models[index]] : [],
  );

describe("structured-output resilience", () => {
  const siblingMarker = "SUSPECTED SIBLING INTERFERENCE";
  const twoTaskScouts = () => [
    multiWave(["ui/main", "ui/sibling"]),
    complete(2),
  ];

  test("a verifier that text-emits its payload is retried one rung stronger", async () => {
    const log = await runOrchestrator({
      scouts: [wave("ui/01", 1, 0), complete(1)],
      gate: { "ui/01": [THROWS, { passed: true, summary: "green" }] },
    });
    expect(log.result.completed).toEqual(["ui/01"]);
    expect(log.result.escalations).toEqual([]);
    expect(callsTo(log.labels, "verify:ui/01#1")).toBe(2);
    expect(modelsFor(log, "verify:ui/01#1")).toEqual(["haiku", "sonnet"]);
  });

  test("the retry does not consume an attempt", async () => {
    // The throw is an infrastructure fault, not a verdict on the work. Charging
    // it to the attempt budget would park a task the dev could still have fixed.
    const log = await runOrchestrator({
      scouts: [wave("ui/01", 1, 0), complete(1)],
      gate: {
        "ui/01": [THROWS, { passed: false, summary: "red" }],
      },
    });
    expect(callsTo(log.labels, "dev:ui/01#2")).toBe(1);
  });

  test("a second text-emitted payload parks the task", async () => {
    const { result, labels } = await runOrchestrator({
      scouts: [wave("ui/01", 1, 0), complete(1)],
      gate: { "ui/01": [THROWS, THROWS] },
    });
    expect(result.completed).toEqual([]);
    const [escalation] = result.escalations;
    expect(escalation.task).toBe("ui/01");
    expect(escalation.infrastructure).toBe(true);
    expect(escalation.reason).toMatch(/StructuredOutput/);
    // Once, and only once: a retry loop would burn the run instead of parking.
    expect(callsTo(labels, "verify:ui/01#1")).toBe(2);
  });

  test("a scout that text-emits is retried before the run gives up", async () => {
    const log = await runOrchestrator({
      scouts: [THROWS, wave("ui/01", 1, 0), complete(1)],
    });
    expect(log.result.completed).toEqual(["ui/01"]);
    expect(log.result.escalations).toEqual([]);
    expect(modelsFor(log, "scout-wave-1")).toEqual(["haiku", "sonnet"]);
  });

  test("the judge is NOT retried — it persists a verdict before it returns", async () => {
    // `score-task.ts --log` appends a row keyed by ref+attempt, and fleet.ts
    // keeps the FIRST row for that key. Retrying would score the same attempt
    // twice and the orchestrator would act on the second, leaving the trail
    // contradicting the decision it records. Parking is what happened before
    // this helper existed, and it is never worse than a lying trail.
    const { result, labels } = await runOrchestrator({
      scouts: [wave("ui/01", 1, 0), complete(1)],
      judge: { "ui/01": [THROWS] },
    });
    expect(callsTo(labels, "judge:ui/01#1")).toBe(1);
    expect(result.completed).toEqual([]);
    expect(result.escalations[0].infrastructure).toBe(true);
    expect(result.escalations[0].reason).toMatch(/StructuredOutput/);
  });

  test("mark-done and the park are both retried", async () => {
    const log = await runOrchestrator({
      scouts: [wave("ui/01", 1, 0), complete(1)],
      markDone: { "ui/01": [THROWS, { ok: true, status: "done" }] },
    });
    expect(log.result.completed).toEqual(["ui/01"]);
    expect(callsTo(log.labels, "done:ui/01")).toBe(2);

    const parked = await runOrchestrator({
      scouts: [wave("ui/02", 1, 0), complete(1)],
      gate: { "ui/02": [null] },
      park: { "ui/02": [THROWS, { ok: true, status: "blocked" }] },
    });
    expect(parked.result.escalations[0].parked).toBe(true);
    expect(callsTo(parked.labels, "block:ui/02")).toBe(2);
  });

  test("the commit agents are NOT retried", async () => {
    // The one call here that is not idempotent: a retry after a partial commit
    // writes a second, incoherent one. It keeps settled() — report, never re-run.
    const { result, labels } = await runOrchestrator({
      scouts: [wave("ui/01", 2, 0), wave("ui/02", 2, 1), complete(2)],
      commit: [THROWS],
    });
    expect(callsTo(labels, "commit-wave-2")).toBe(1);
    expect(result.escalations[0].task).toBe("(commit)");
  });

  test("every schema'd prompt states the return contract", async () => {
    // The schema is invisible to the agent: without this sentence nothing in the
    // prompt says HOW to return, and a model that has just finished a long
    // tool-heavy turn writes the payload as text believing it answered.
    const sibling = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: twoTaskScouts(),
      gate: {
        "ui/main": [{ passed: false, deferred: true, summary: siblingMarker }],
      },
      devHolds: { "ui/sibling": sibling.held },
      agentCalls: calls,
    });
    await waitForCall(calls, "verify:ui/main#1");
    sibling.release();
    const log = await run;

    for (const label of [
      "scout-wave-1",
      "verify:ui/main#1",
      "requalify:ui/main#1",
      "judge:ui/main#1",
      "done:ui/main",
      "commit-post-loop",
    ]) {
      // Position, not mere presence. An instruction placed AFTER the contract
      // tells the agent to keep working past the call it was just told to make
      // — which is how the scout lost its completion flightlog row in review.
      expect(promptFor(log, label).trimEnd()).toEndWith(
        "the harness rejects the call and the work you just did is discarded.",
      );
    }
    // The clause must not read as a hedge on the verifier's exit rule.
    expect(promptFor(log, "verify:ui/main#1")).not.toMatch(
      /unless|except|may still pass|can be ignored|disregard/i,
    );
  });
});
