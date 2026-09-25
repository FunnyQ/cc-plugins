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
import { parseModels } from "../../flightplan/scripts/lib/parse-task";

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
  /** The scout's structured copy of the cap; optional so a scout can omit it. */
  maxParallel?: unknown;
  readyModels?: { ref: string; modelsRaw?: unknown }[];
} | null;

const snapshot = (
  tree: Record<string, unknown>,
  exitCode = 0,
): ScoutResult => ({
  stdout: JSON.stringify({
    ready: [],
    unfinished: [],
    invalid: [],
    errors: [],
    maxParallel: null,
    ...tree,
  }),
  exitCode,
  stderr: "",
  readyModels: ((tree.ready ?? []) as ReturnType<typeof ready>[]).map(
    ({ ref, modelsRaw }) => ({ ref, modelsRaw }),
  ),
  maxParallel: "maxParallel" in tree ? tree.maxParallel : null,
});

type RunResult = {
  slug: string;
  aborted?: { reason: string; paths: string[] } | null;
  completed: string[];
  escalations: {
    task: string;
    attempt: number;
    infrastructure?: boolean;
    parked?: boolean;
    reason: string;
  }[];
  needsHuman: { task: string; criteria: string[] }[];
  worktrees: { ref: string; path: string }[];
  cleanupFailures: { ref: string; path: string }[];
};

type Scenario = {
  worktree?: Record<string, (Record<string, unknown> | Throws | null)[]>;
  worktreeHolds?: Record<string, Promise<void>>;
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
    (
      | {
          passed: boolean;
          deferred?: boolean;
          summary: string;
          humanPending?: string[];
        }
      | Throws
      | null
    )[]
  >;
  reverifyHolds?: Record<string, Promise<void>>;
  reverify?: Record<string, ({ passed: boolean; summary: string } | Throws | null)[]>;
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

const ready = (ref: string, finalReview = false, modelsRaw: string | null = null) => ({
  modelsRaw,
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
  for (const [field, literal] of Object.entries({ repoRoot: "'/abs/repo'", ...overrides })) {
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

type AgentSchema = {
  type: string | string[];
  properties?: Record<string, AgentSchema>;
  required?: string[];
  items?: AgentSchema;
  enum?: string[];
};

type RunLog = {
  result: RunResult;
  /** Every agent label, in call order. */
  labels: string[];
  /** Every agent prompt, in call order. */
  prompts: string[];
  /** Every agent model, in call order. */
  models: (string | undefined)[];
  efforts: (string | undefined)[];
  effortKeys: boolean[];
  schemas: (AgentSchema | undefined)[];
};

async function runOrchestrator(
  scenario: Scenario,
  overrides: ConfigOverrides = {},
): Promise<RunLog> {
  const src = await loadScript(overrides);
  const labels: string[] = [];
  const prompts: string[] = [];
  const models: (string | undefined)[] = [];
  const efforts: (string | undefined)[] = [];
  const effortKeys: boolean[] = [];
  const schemas: (AgentSchema | undefined)[] = [];
  let budgetSpent = scenario.budget?.spent ?? 0;
  const scouts = [...scenario.scouts];
  const commits = [...(scenario.commit ?? [])];
  const queues = new Map<string, unknown[]>();
  const take = (bucket: string, ref: string, fallback: unknown) => {
    const key = `${bucket}:${ref}`;
    if (!queues.has(key)) {
      const source =
        (scenario[
          bucket as "gate" | "requalify" | "reverify" | "judge" | "markDone" | "park" | "worktree"
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

  let fingerprint = 0;
  const landFiles = new Map<string, unknown>();
  const agent = async (
    prompt: string,
    opts: { label: string; model?: string; effort?: string; schema?: AgentSchema },
  ) => {
    const label = opts.label;
    labels.push(label);
    scenario.agentCalls?.push(label);
    prompts.push(prompt);
    models.push(opts.model);
    efforts.push(opts.effort);
    effortKeys.push(Object.hasOwn(opts, "effort"));
    schemas.push(opts.schema);

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

    if (role.startsWith("wt-")) {
      if (scenario.worktreeHolds?.[label]) await scenario.worktreeHolds[label];
      const ref = refOf(label);
      const path = `/wt/${ref}`;
      const defaults: Record<string, Record<string, unknown>> = {
        "wt-create": { path, base: "b0" },
        "wt-land": {
          status: "clean", drift: false, files: [], paths: [],
          fingerprint: `f${role === "wt-land" ? ++fingerprint : fingerprint}`,
          previous: /--expect (\S+)/.exec(prompt)?.[1] ?? "",
        },
        "wt-rebase": { path, base: "b1", conflicted: landFiles.get(ref) ?? [] },
        "wt-unland": { restored: [] },
        "wt-remove": { removed: true },
        "wt-show": { path, base: "b0", exists: true },
        "wt-leak": { fingerprint: "f0", paths: [] },
        "wt-sweep": {
          removed: [],
          kept: (/--keep (\S+)/.exec(prompt)?.[1].split(",") ?? [])
            .map((ref) => ({ ref, path: `/wt/${ref}` })),
        },
      };
      if (!defaults[role]) throw new Error(`unhandled worktree label: ${label}`);
      const result = take("worktree", label, defaults[role]) as Record<string, unknown> | null;
      if (role === "wt-land" && result) landFiles.set(ref, result.files);
      return result;
    }

    if (role === "verify") {
      return take("gate", refOf(rest), { passed: true, summary: "green" });
    }
    if (role === "reverify") {
      if (scenario.reverifyHolds?.[refOf(rest)]) await scenario.reverifyHolds[refOf(rest)];
      return take("reverify", refOf(rest), { passed: true, summary: "green after drift" });
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
  return { result, labels, prompts, models, efforts, effortKeys, schemas };
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

function effortFor(log: Pick<RunLog, "labels" | "efforts">, label: string) {
  const index = log.labels.indexOf(label);
  if (index === -1) throw new Error(`agent label not found: ${label}`);
  return log.efforts[index];
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
      "- attempt 1 (ran on opus/medium): Binary gate failed (verification/acceptance):\nattempt one tests red",
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

  test("the default Claude ladder raises effort on the final opus rung", async () => {
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
      "opus",
      "opus",
      "opus",
    ]);
    expect(devLabels.map((label) => effortFor(log, label))).toEqual([
      "medium", "medium", "high",
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

  // The prompt-level ban is carried by the agent that writes the instruction file
  // and was measured not to survive that trip. This flag makes relay append the
  // contract itself, so it is the live path's only real enforcement.
  test("passes --no-ask so the live pane cannot stop to ask", async () => {
    const prompt = await reviewPrompt({
      liveReviewEngine: "true",
      relayPath: "'/abs/relay/relay.ts'",
    });

    expect(prompt).toContain("--no-ask");
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

  // Same reasoning as the review lens: the rule the driver is asked to copy into
  // the instruction file did not arrive in two measured runs, so the flag relay
  // reads is what actually holds on the live dev path.
  test("the live dev delegate passes --no-ask to relay", async () => {
    const log = await runOrchestrator(
      { scouts: [devWave, complete(2)] },
      {
        devEngine: "'codex'",
        liveDevEngine: "true",
        relayPath: "'/abs/relay/relay.ts'",
      },
    );
    const prompt = promptFor(log, "dev-codex:ui/01#1");

    expect(prompt).toContain("bun /abs/relay/relay.ts codex delegate");
    expect(prompt).toContain("--no-ask");
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

  // The DELEGATE is the opposite case: it holds the shell and the working tree,
  // so it is the only party that can act on red output. Copying Acceptance
  // criteria without the Verification commands hands it the claim it is graded
  // on but not the command that proves it — measured on one 47-task flight,
  // 13 of 23 retried tasks failed at the first verify, on commands the engine
  // had never been shown.
  test("the delegate instruction carries the verification commands and runs them", async () => {
    const log = await runOrchestrator(
      { scouts: [devWave, complete(2)] },
      { devEngine: "'codex'" },
    );
    const prompt = promptFor(log, "dev-codex:ui/01#1");

    // Assert the COPY LIST, not a bare "## Verification" — that string already
    // occurs in the driver's own "do NOT run" sentence and would pass either way.
    expect(prompt).toContain(
      'copy its Goal, "Files to create / modify", Implementation notes, Acceptance criteria, and ## Verification commands',
    );
    expect(prompt).toContain("RUN the Verification commands itself");
    // Inviting the engine to chase green is what makes this guard load-bearing:
    // the downstream verifier re-runs the SAME commands, so a weakened test
    // passes both gates and the corruption survives the loop.
    expect(prompt).toContain("never edits, weakens, or skips");
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
    const log = await run;
    const { result, labels } = log;
    expect(modelFor(log, "requalify:ui/main#1")).toBe("opus");
    expect(effortFor(log, "requalify:ui/main#1")).toBe("low");

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

  test("a verifier that text-emits its payload is retried with the structured choice", async () => {
    const log = await runOrchestrator({
      scouts: [wave("ui/01", 1, 0), complete(1)],
      gate: { "ui/01": [THROWS, { passed: true, summary: "green" }] },
    });
    expect(log.result.completed).toEqual(["ui/01"]);
    expect(log.result.escalations).toEqual([]);
    expect(callsTo(log.labels, "verify:ui/01#1")).toBe(2);
    expect(modelsFor(log, "verify:ui/01#1")).toEqual(["opus", "opus"]);
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
    expect(modelsFor(log, "scout-wave-1")).toEqual(["haiku", "opus"]);
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

// PLAN-LEVEL CONCURRENCY CAP
// ══════════════════════════════════════════════════════════════════════════
// A plan whose tasks share a resource the working tree cannot express — one
// SwiftPM target, one live device — declares `> **Max parallel**: N` in
// PLAN.md, and the scout carries it as `maxParallel`. The cap wraps the WHOLE
// task pipeline, not just dev: the live incident was a verifier running
// `swift build` while a sibling's delegate was mid-reinstall, and a verifier is
// not a writer, so capping writers alone would have let it through.
describe("plan concurrency cap", () => {
  const capped = (refs: string[], maxParallel: number | null) =>
    snapshot({
      ready: refs.map((ref) => ready(ref)),
      counts: counts({ total: refs.length, todo: refs.length }),
      unfinished: refs.map((ref) => ({ ref, state: "todo" })),
      maxParallel,
    });

  test("maxParallel 1 runs each task's whole pipeline before the next starts", async () => {
    const first = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: [capped(["ui/01", "ui/02"], 1), complete(2)],
      devHolds: { "ui/01": first.held },
      agentCalls: calls,
    });

    await waitForCall(calls, "dev:ui/01#1");
    // Give a wrongly-parallel run every chance to dispatch the second task.
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(calls).not.toContain("dev:ui/02#1");
    first.release();
    const { result, labels } = await run;

    expect(result.completed).toEqual(["ui/01", "ui/02"]);
    expect(labels.indexOf("dev:ui/02#1")).toBeGreaterThan(
      labels.indexOf("done:ui/01"),
    );
  });

  test("a task that parks still frees its slot", async () => {
    const { result, labels } = await runOrchestrator({
      scouts: [capped(["ui/01", "ui/02"], 1)],
      gate: { "ui/01": [null] },
    });

    expect(labels.indexOf("dev:ui/02#1")).toBeGreaterThan(
      labels.indexOf("block:ui/01"),
    );
    expect(accountsForEveryTask(result, ["ui/01", "ui/02"])).toBe(true);
  });

  test("a thrown pipeline still frees its slot", async () => {
    const { result } = await runOrchestrator({
      scouts: [
        capped(["ui/01", "ui/02"], 1),
        snapshot({
          counts: counts({ total: 2, done: 1, blocked: 1 }),
          unfinished: [{ ref: "ui/01", state: "blocked" }],
        }),
      ],
      devThrows: ["ui/01"],
    });

    expect(result.completed).toEqual(["ui/02"]);
    expect(result.escalations.map((e) => e.task)).toEqual(["ui/01"]);
  });

  test("maxParallel 2 holds the third task until a slot frees", async () => {
    const one = latch();
    const two = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: [capped(["ui/01", "ui/02", "ui/03"], 2), complete(3)],
      devHolds: { "ui/01": one.held, "ui/02": two.held },
      agentCalls: calls,
    });

    await waitForCall(calls, "dev:ui/01#1");
    await waitForCall(calls, "dev:ui/02#1");
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(calls).not.toContain("dev:ui/03#1");
    one.release();
    await waitForCall(calls, "dev:ui/03#1");
    two.release();
    const { result } = await run;

    expect(result.completed).toEqual(["ui/01", "ui/02", "ui/03"]);
  });

  test("a null cap dispatches the whole wave at once", async () => {
    const holds = ["ui/01", "ui/02", "ui/03"].map(() => latch());
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: [capped(["ui/01", "ui/02", "ui/03"], null), complete(3)],
      devHolds: {
        "ui/01": holds[0].held,
        "ui/02": holds[1].held,
        "ui/03": holds[2].held,
      },
      agentCalls: calls,
    });

    for (const ref of ["ui/01", "ui/02", "ui/03"]) {
      await waitForCall(calls, `dev:${ref}#1`);
    }
    holds.forEach((hold) => hold.release());
    expect((await run).result.completed).toHaveLength(3);
  });

  // A serial task has no sibling writing beside it, so a sibling excuse is
  // always unsupported there and must not buy a requalify.
  test("a serial wave rejects a sibling deferral", async () => {
    // The held sibling makes this load-bearing: dispatched in parallel, it would
    // be a live writer and the deferral would be accepted.
    const sibling = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      devHolds: { "ui/sibling": sibling.held },
      agentCalls: calls,
      scouts: [capped(["ui/main", "ui/sibling"], 1), complete(2)],
      gate: {
        "ui/main": [
          {
            passed: false,
            deferred: true,
            summary: "SUSPECTED SIBLING INTERFERENCE",
          },
          { passed: true, summary: "retry passed" },
        ],
      },
    });

    await waitForCall(calls, "verify:ui/main#1");
    sibling.release();
    const { labels } = await run;

    expect(labels.some((label) => label.startsWith("requalify:"))).toBe(false);
    expect(labels).toContain("dev:ui/main#2");
  });

  // wf_84deb543-ea1: the Haiku scout transcribed stdout through "errors":[]} and
  // dropped the trailing field. The structured copy is what the run trusts.
  test("stdout missing maxParallel still runs on the structured cap", async () => {
    const scout = capped(["ui/01", "ui/02"], 1)!;
    const { maxParallel: _dropped, ...rest } = JSON.parse(scout.stdout);
    const first = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: [{ ...scout, stdout: JSON.stringify(rest) }, complete(2)],
      devHolds: { "ui/01": first.held },
      agentCalls: calls,
    });

    await waitForCall(calls, "dev:ui/01#1");
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(calls).not.toContain("dev:ui/02#1");
    first.release();
    const { result } = await run;

    expect(result.escalations).toEqual([]);
    expect(result.completed).toEqual(["ui/01", "ui/02"]);
  });

  // A scout that omits the structured cap must not read as "no cap": that is
  // the silent parallel run a serial plan exists to prevent.
  test("a scout missing the structured maxParallel escalates", async () => {
    const { maxParallel: _dropped, ...scout } = capped(["ui/01"], 1)!;
    const { result, labels } = await runOrchestrator({ scouts: [scout] });

    expect(result.escalations[0].task).toBe("(scout)");
    expect(result.escalations[0].reason).toContain('"maxParallel"');
    expect(labels.some((label) => label.startsWith("dev"))).toBe(false);
  });

  // Two copies that disagree mean one is wrong, and nothing says which.
  test("a structured cap that contradicts stdout escalates", async () => {
    const { result, labels } = await runOrchestrator({
      scouts: [{ ...capped(["ui/01"], 1)!, maxParallel: null }],
    });

    expect(result.escalations[0].task).toBe("(scout)");
    expect(result.escalations[0].reason).toContain('"maxParallel"');
    expect(labels.some((label) => label.startsWith("dev"))).toBe(false);
  });

  test.each([0, -1, 1.5, "1"])(
    "maxParallel %p escalates as a scout failure",
    async (value) => {
      const { result } = await runOrchestrator({
        scouts: [
          snapshot({
            ready: [ready("ui/01")],
            counts: counts({ total: 1, todo: 1 }),
            unfinished: [{ ref: "ui/01", state: "todo" }],
            maxParallel: value,
          }),
        ],
      });

      expect(result.escalations[0].task).toBe("(scout)");
      expect(result.escalations[0].reason).toContain('"maxParallel"');
    },
  );
});

describe("orchestrator human-only gate items", () => {
  const humanWave: ScoutResult = snapshot({
    ready: [ready("ui/01")],
    counts: counts({ total: 1, todo: 1 }),
    unfinished: [{ ref: "ui/01", state: "todo" }],
  });

  test("a passing gate with pending human items completes and reports needsHuman", async () => {
    const { result } = await runOrchestrator({
      scouts: [humanWave, complete(1)],
      gate: {
        "ui/01": [
          {
            passed: true,
            summary: "green; 1 item not machine-checked",
            humanPending: ["Acceptance criteria: (human) sweep the notch"],
          },
        ],
      },
    });

    expect(result.completed).toEqual(["ui/01"]);
    // A pending human item is not a park. Reporting it as one would send the
    // user to reset a Status that is legitimately `done`.
    expect(result.escalations).toEqual([]);
    expect(result.needsHuman).toEqual([
      {
        task: "ui/01",
        criteria: ["Acceptance criteria: (human) sweep the notch"],
      },
    ]);
  });

  test("a failed gate's pending list never reaches needsHuman", async () => {
    // The retry re-derives the list from the same task file, so carrying a
    // rejected attempt's list forward would report an item twice.
    const { result } = await runOrchestrator({
      scouts: [humanWave],
      gate: {
        "ui/01": [
          { passed: false, summary: "red", humanPending: ["a"] },
          { passed: false, summary: "red", humanPending: ["a"] },
          { passed: false, summary: "red", humanPending: ["a"] },
        ],
      },
    });

    expect(result.needsHuman).toEqual([]);
    expect(result.escalations).toHaveLength(1);
  });

  test("a verifier that omits humanPending entirely is not a failure", async () => {
    const { result } = await runOrchestrator({
      scouts: [humanWave, complete(1)],
      gate: { "ui/01": [{ passed: true, summary: "green" }] },
    });

    expect(result.completed).toEqual(["ui/01"]);
    expect(result.needsHuman).toEqual([]);
  });

  test("the verifier is told the tag exempts one item, never the task", async () => {
    const log = await runOrchestrator({ scouts: [humanWave, complete(1)] });
    const prompt = promptFor(log, "verify:ui/01#1");

    expect(prompt).toContain("(human)");
    expect(prompt).toContain("humanPending");
    expect(prompt).toContain("The tag exempts that ONE item");
    expect(prompt).toContain("You may never add the tag yourself");
  });

  test("the attestation clause appears only when an attestation file is configured", async () => {
    const without = await runOrchestrator({ scouts: [humanWave, complete(1)] });
    expect(promptFor(without, "verify:ui/01#1")).not.toContain(
      "It is not a blanket pass",
    );

    const withFile = await runOrchestrator(
      { scouts: [humanWave, complete(1)] },
      { attestationFile: "'/abs/repo/docs/my-plan/.flightlog/attested.md'" },
    );
    const prompt = promptFor(withFile, "verify:ui/01#1");
    expect(prompt).toContain("/abs/repo/docs/my-plan/.flightlog/attested.md");
    expect(prompt).toContain("It is not a blanket pass");
    // The bound that stops one sentence of attestation excusing every red item.
    expect(prompt).toContain("covers ONLY the items it names");
    expect(prompt).toContain("that entry is invalid");
  });
});

describe("orchestrator single-task resume", () => {
  const RESUME_CFG = {
    resumeTask: "'review/01'",
    resumeTaskPath: "'/abs/repo/docs/my-plan/tasks/review/01.md'",
    resumeFinalReview: "true",
  };
  const ATTESTED = "'/abs/repo/docs/my-plan/.flightlog/attested.md'";

  test("resuming at verify skips the whole review round and runs no scout", async () => {
    const { result, labels } = await runOrchestrator(
      { scouts: [] },
      {
        ...RESUME_CFG,
        resumeFrom: "'verify'",
        resumeAttempt: "3",
      },
    );

    expect(result.completed).toEqual(["review/01"]);
    expect(result.escalations).toEqual([]);
    expect(labels.some((l) => l.startsWith("scout-wave-"))).toBe(false);
    expect(labels.some((l) => l.startsWith("review:"))).toBe(false);
    expect(labels.some((l) => l.startsWith("fix:"))).toBe(false);
    expect(labels).toContain("verify:review/01#3");
    expect(labels).toContain("judge:review/01#3");
    expect(labels).toContain("done:review/01");
  });

  test("the resumed run still commits, which is what lands the held-back work", async () => {
    // The run that parked this task kept its declared paths out of every commit,
    // so the fixer's edits are still uncommitted when the resume starts.
    const { labels } = await runOrchestrator(
      { scouts: [] },
      {
        ...RESUME_CFG,
        resumeFrom: "'verify'",
        resumeAttempt: "3",
      },
    );

    expect(labels).toContain("commit-post-loop");
  });

  test("resuming past the cap runs the attempts instead of silently re-parking", async () => {
    // The trap: `for (attempt = 3; attempt <= FINAL_MAX)` is false on entry, so
    // a cap-keyed loop parks the task having executed nothing at all.
    const { result, labels } = await runOrchestrator(
      {
        scouts: [],
        gate: {
          "review/01": [
            { passed: false, summary: "resumed round still red" },
            { passed: false, summary: "next round red too" },
          ],
        },
      },
      { ...RESUME_CFG, resumeFrom: "'verify'", resumeAttempt: "3" },
    );

    expect(labels).toContain("verify:review/01#3");
    expect(labels).toContain("verify:review/01#4");
    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0].attempt).toBe(4);
    expect(result.escalations[0].infrastructure).toBe(false);
  });

  test("a red resumed gate runs the FULL pipeline on the next attempt", async () => {
    const { labels } = await runOrchestrator(
      {
        scouts: [],
        gate: {
          "review/01": [
            { passed: false, summary: "resumed round still red" },
            { passed: true, summary: "green" },
          ],
        },
      },
      { ...RESUME_CFG, resumeFrom: "'verify'", resumeAttempt: "3" },
    );

    // Attempt 3 skipped the round; attempt 4 must not — a red verify means the
    // skipped work genuinely does need redoing.
    expect(labels).not.toContain("review:reuse#3");
    expect(labels).toContain("review:reuse#4");
    expect(labels).toContain("fix:review/01#4");
  });

  test("resuming at judge substitutes the signed gate and runs no verifier", async () => {
    const log = await runOrchestrator(
      { scouts: [] },
      {
        ...RESUME_CFG,
        resumeFrom: "'judge'",
        resumeAttempt: "3",
        attestationFile: ATTESTED,
      },
    );

    expect(log.labels.some((l) => l.startsWith("verify:"))).toBe(false);
    const prompt = promptFor(log, "judge:review/01#3");
    expect(prompt).toContain("HUMAN-SUPPLIED BINARY GATE");
    expect(prompt).toContain("/abs/repo/docs/my-plan/.flightlog/attested.md");
    expect(prompt).toContain("Do not assume an unnamed item passed");
    expect(log.result.completed).toEqual(["review/01"]);
  });

  test("the resumed attempt logs why it has no dev row, and only that attempt", async () => {
    const log = await runOrchestrator(
      {
        scouts: [],
        gate: {
          "review/01": [
            { passed: false, summary: "red" },
            { passed: true, summary: "green" },
          ],
        },
      },
      { ...RESUME_CFG, resumeFrom: "'verify'", resumeAttempt: "3" },
    );

    expect(promptFor(log, "verify:review/01#3")).toContain("--role resume");
    expect(promptFor(log, "verify:review/01#4")).not.toContain("--role resume");
  });

  test("a resumed Claude ladder raises effort only on its final rung", async () => {
    // Keyed off `cap` rather than `last`, `attempt >= claudeCap` is already true
    // at attempt 2, so the whole ladder would raise effort from its first rung.
    const log = await runOrchestrator(
      {
        scouts: [],
        gate: {
          "ui/01": [
            { passed: false, summary: "red" },
            { passed: false, summary: "red" },
            { passed: false, summary: "red" },
          ],
        },
      },
      {
        resumeTask: "'ui/01'",
        resumeTaskPath: "'/abs/repo/docs/my-plan/tasks/ui/01.md'",
        resumeFrom: "'dev'",
        resumeAttempt: "2",
      },
    );

    const devLabels = log.labels.filter((label) => label.startsWith("dev:"));
    expect(devLabels).toEqual(["dev:ui/01#2", "dev:ui/01#3", "dev:ui/01#4"]);
    expect(devLabels.map((label) => modelFor(log, label))).toEqual([
      "opus",
      "opus",
      "opus",
    ]);
    expect(devLabels.map((label) => effortFor(log, label))).toEqual([
      "medium", "medium", "high",
    ]);
  });

  test("a resumed task that cannot pass is parked and escalated as usual", async () => {
    const { result } = await runOrchestrator(
      { scouts: [], gate: { "review/01": [null] } },
      { ...RESUME_CFG, resumeFrom: "'verify'", resumeAttempt: "3" },
    );

    expect(result.completed).toEqual([]);
    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0].task).toBe("review/01");
    expect(result.escalations[0].infrastructure).toBe(true);
    expect(result.escalations[0].parked).toBe(true);
  });

  test.each([
    [{ resumeFrom: "'score'" }, 'unknown resumeFrom "score"'],
    [{ resumeTaskPath: "''" }, "resumeTaskPath is empty"],
    [{ resumeFrom: "'judge'" }, "CFG.attestationFile is required"],
    // `Math.trunc(Number(0)) || 1` silently renumbers this to attempt 1, which
    // then collides with the parked run's own attempt 1 in the score rows.
    [
      { resumeAttempt: "0" },
      "resumeAttempt must be a whole number 1 or greater",
    ],
    [{ resumeAttempt: "'later'" }, "resumeAttempt must be a whole number"],
  ])(
    "rejects bad resume config at script start (%o)",
    async (over, message) => {
      await expect(
        runOrchestrator(
          { scouts: [] },
          {
            ...RESUME_CFG,
            resumeFrom: "'verify'",
            resumeAttempt: "3",
            ...over,
          },
        ),
      ).rejects.toThrow(message);
    },
  );

  test("an empty resumeTask leaves the normal wave loop untouched", async () => {
    const { result, labels } = await runOrchestrator({
      scouts: [wave("ui/01", 1, 0), complete(1)],
    });

    expect(result.completed).toEqual(["ui/01"]);
    expect(labels).toContain("scout-wave-1");
  });
});

describe("per-role model and effort choices", () => {
  const modelWave = (modelsRaw: string | null, finalReview = false) =>
    snapshot({
      ready: [ready("ui/01", finalReview, modelsRaw)],
      counts: counts({ total: 1, todo: 1 }),
      unfinished: [{ ref: "ui/01", state: "todo" }],
    });
  const red = { passed: false, summary: "red" };
  const assertChoice = (
    log: RunLog,
    label: string,
    model: string,
    effort?: string,
  ) => {
    expect(modelFor(log, label)).toBe(model);
    expect(effortFor(log, label)).toBe(effort);
    expect(log.effortKeys[log.labels.indexOf(label)]).toBe(
      effort !== undefined,
    );
  };

  test("null modelsRaw uses every role's default", async () => {
    const log = await runOrchestrator({
      scouts: [
        modelWave(null),
        snapshot({
          ready: [ready("review/01", true)],
          counts: counts({ total: 2, todo: 1, done: 1 }),
          unfinished: [{ ref: "review/01", state: "todo" }],
        }),
        complete(2),
      ],
    });
    expect(log.result.escalations).toEqual([]);
    assertChoice(log, "dev:ui/01#1", "opus", "medium");
    assertChoice(log, "verify:ui/01#1", "opus", "low");
    assertChoice(log, "judge:ui/01#1", "opus", "medium");
    assertChoice(log, "fix:review/01#1", "opus", "high");
    assertChoice(log, "done:ui/01", "haiku");
    assertChoice(log, "scout-wave-1", "haiku");
    assertChoice(log, "commit-wave-2", "opus", "low");
    assertChoice(log, "commit-post-loop", "opus", "low");
    assertChoice(log, "review:codex#1", "haiku");
    for (const lens of ["reuse", "leanness", "efficiency"]) {
      assertChoice(log, `review:${lens}#1`, "opus");
    }
    const blocked = await runOrchestrator({
      scouts: [modelWave(null)],
      gate: { "ui/01": [null] },
    });
    assertChoice(blocked, "block:ui/01", "haiku");
  });

  test.each([
    ["dev=sonnet/low", "sonnet", ["low", "low", "medium"]],
    ["dev=opus/max", "opus", ["max", "max", "max"]],
    ["dev=opus", "opus", [undefined, undefined, undefined]],
    [null, "opus", ["medium", "medium", "high"]],
  ] as const)("dev ladder uses %s", async (raw, model, efforts) => {
    const log = await runOrchestrator({
      scouts: [modelWave(raw)],
      gate: { "ui/01": [red, red, red] },
    });
    efforts.forEach((effort, index) =>
      assertChoice(log, `dev:ui/01#${index + 1}`, model, effort),
    );
    expect(log.result.escalations[0].reason).toContain(
      `ran on ${model}${efforts[0] ? `/${efforts[0]}` : ""}`,
    );
  });

  test("verify override drops the default effort and structured retry replaces both fields", async () => {
    const log = await runOrchestrator({
      scouts: [modelWave("verify=sonnet"), complete(1)],
      gate: { "ui/01": [THROWS, { passed: true, summary: "green" }] },
    });
    assertChoice(log, "verify:ui/01#1", "sonnet");
    const retry = log.labels.lastIndexOf("verify:ui/01#1");
    expect([
      log.models[retry],
      log.efforts[retry],
      log.effortKeys[retry],
    ]).toEqual(["opus", "medium", true]);
    expect(log.result.completed).toEqual(["ui/01"]);
  });

  test("fix override replaces its whole choice", async () => {
    const log = await runOrchestrator({
      scouts: [modelWave("fix=fable/low", true), complete(1)],
    });
    assertChoice(log, "fix:ui/01#1", "fable", "low");
  });

  test.each(["missing", "mismatch", "invalid"])(
    "scout rejects %s modelsRaw",
    async (kind) => {
      const scout = modelWave("dev=sonnet/low")!;
      if (kind === "missing") scout.readyModels = [];
      if (kind === "mismatch")
        scout.readyModels = [{ ref: "ui/01", modelsRaw: "dev=opus" }];
      if (kind === "invalid") {
        scout.readyModels = [{ ref: "ui/01", modelsRaw: "dev=Opus" }];
        scout.stdout = scout.stdout.replace("dev=sonnet/low", "dev=Opus");
      }
      const log = await runOrchestrator({ scouts: [scout] });
      expect(log.result.escalations[0].task).toBe("(scout)");
      expect(log.result.escalations[0].reason).toContain("ui/01");
      expect(log.labels.some((label) => label.startsWith("dev:"))).toBe(false);
      if (kind === "mismatch") {
        expect(log.result.escalations[0].reason).toContain("dev=sonnet/low");
        expect(log.result.escalations[0].reason).toContain("dev=opus");
      }
    },
  );

  const parityFixtures: {
    raw: string;
    choices: Record<string, { model: string; effort: string | null }> | null;
  }[] = [
    {
      raw: "dev=opus/high, verify=sonnet",
      choices: {
        dev: { model: "opus", effort: "high" },
        verify: { model: "sonnet", effort: null },
      },
    },
    {
      raw: "judge = opus / xhigh",
      choices: { judge: { model: "opus", effort: "xhigh" } },
    },
    { raw: "dev=opus,", choices: { dev: { model: "opus", effort: null } } },
    {
      raw: " dev=sonnet/low , verify=haiku ",
      choices: {
        dev: { model: "sonnet", effort: "low" },
        verify: { model: "haiku", effort: null },
      },
    },
    ...[
      "dev=opus, dev=sonnet",
      "dev=gpt5",
      "dev=Opus",
      "",
      "dev=opus/high/max",
    ].map((raw) => ({ raw, choices: null })),
  ];
  test.each(parityFixtures)("parser parity: $raw", async ({ raw, choices }) => {
    const parsed = parseModels(raw);
    const log = await runOrchestrator({
      scouts: [modelWave(raw), complete(1)],
    });
    if (choices === null) {
      expect(parsed.errors.length).toBeGreaterThan(0);
      expect(log.result.escalations[0].task).toBe("(scout)");
      expect(log.result.escalations[0].reason).toContain("ui/01");
      expect(log.result.completed).toEqual([]);
    } else {
      expect(parsed.errors).toEqual([]);
      expect(parsed.models).toEqual(choices);
      expect(log.result.completed).toEqual(["ui/01"]);
      for (const [role, choice] of Object.entries(choices)) {
        assertChoice(
          log,
          `${role}:ui/01#1`,
          choice.model,
          choice.effort ?? undefined,
        );
      }
    }
  });

  test.each([
    [
      { devEngine: "'codex'", lastShotEngine: "'opencode'" },
      ["dev-codex:ui/01#1", "dev-codex:ui/01#2"],
    ],
    [{ lastShotEngine: "'codex'" }, ["dev-codex:ui/01#4"]],
  ] as [ConfigOverrides, string[]][])(
    "external driver preserves rungs %o",
    async (config, labels) => {
      const log = await runOrchestrator(
        {
          scouts: [modelWave("dev=sonnet/low")],
          gate: { "ui/01": [red, red, red, red] },
        },
        config,
      );
      labels.forEach((label) => assertChoice(log, label, "haiku"));
      assertChoice(log, "dev:ui/01#3", "sonnet", "medium");
    },
  );

  const resume = {
    resumeTask: "'ui/01'",
    resumeTaskPath: "'/abs/task.md'",
    resumeModelsRaw: "'dev=sonnet/low'",
  };
  test("resume carries the model header", async () => {
    const log = await runOrchestrator({ scouts: [] }, resume);
    assertChoice(log, "dev:ui/01#1", "sonnet", "low");
    expect(log.result.completed).toEqual(["ui/01"]);
  });
  test("invalid resume models fail before any agent", async () => {
    const agentCalls: string[] = [];
    await expect(
      runOrchestrator(
        { scouts: [], agentCalls },
        { ...resume, resumeModelsRaw: "'dev=Opus'" },
      ),
    ).rejects.toThrow("Models");
    expect(agentCalls).toEqual([]);
  });
});

describe("task worktree isolation", () => {
  const ref = "ui/01";
  const cleanLand = {
    status: "clean", drift: false, files: [], paths: [],
    fingerprint: "landed", previous: "f0",
  };
  const kept = { ref: "old/01", path: "/old/worktree" };
  const blockedWave = () => snapshot({
    ready: [ready(ref)],
    counts: counts({ total: 2, todo: 1, blocked: 1 }),
    unfinished: [{ ref, state: "todo" }, { ref: kept.ref, state: "blocked" }],
  });
  const blockedEnd = () => snapshot({
    counts: counts({ total: 2, done: 1, blocked: 1 }),
    unfinished: [{ ref: kept.ref, state: "blocked" }],
  });

  test("clean pipeline creates, judges, lands, marks done, then removes", async () => {
    const log = await runOrchestrator({ scouts: [wave(ref, 1, 0), complete(1)] });
    expect(log.labels).toEqual([
      "scout-wave-1", "wt-sweep:start", "wt-leak:baseline",
      `wt-create:${ref}`, `dev:${ref}#1`, `verify:${ref}#1`, `judge:${ref}#1`,
      `wt-land:${ref}`, `done:${ref}`, `wt-remove:${ref}`, "wt-leak:1",
      "scout-wave-2", "wt-sweep:end", "commit-post-loop",
    ]);
    expect(log.result.worktrees).toEqual([]);
    expect(log.result.cleanupFailures).toEqual([]);
    expect(log.result.completed).toEqual([ref]);
    for (const label of log.labels.filter((label) => label.startsWith("wt-"))) {
      expect(promptFor(log, label)).toContain("--repo /abs/repo --slug my-plan");
      expect(promptFor(log, label)).toContain("StructuredOutput");
      expect(modelFor(log, label)).toBe("haiku");
      expect(effortFor(log, label)).toBeUndefined();
    }
  });

  test.each(["claude", "codex", "opencode", "live"])("%s pipeline carries worktree rules", async (engine) => {
    const log = await runOrchestrator({ scouts: [wave(ref, 1, 0), complete(1)] }, {
      devEngine: `'${engine === "live" ? "codex" : engine}'`,
      ...(engine === "live" ? { liveDevEngine: "true", relayPath: "'/abs/relay.ts'" } : {}),
    });
    const driver = engine === "live" ? "codex" : engine;
    const dev = engine === "claude" ? `dev:${ref}#1` : `dev-${driver}:${ref}#1`;
    for (const label of [dev, `verify:${ref}#1`, `judge:${ref}#1`]) {
      const prompt = promptFor(log, label);
      expect(prompt).toContain(`WORKTREE: /wt/${ref}`);
      expect(prompt).toContain(`cd /wt/${ref}`);
      expect(prompt).toContain("flightlog.ts log");
      expect(prompt).toContain("Status line");
      expect(prompt).toContain("/tmp");
      expect(prompt).toContain("Nothing else may be written outside");
      expect(prompt).toContain("absolute path");
      expect(prompt).toContain("relative to the repo root");
    }
    if (engine !== "claude") {
      expect(promptFor(log, dev)).toMatch(new RegExp(`cd /wt/${ref} && bun .+delegate`));
      expect(promptFor(log, dev)).toContain("Include the worktree rules in that instruction");
    }
    expect(promptFor(log, `done:${ref}`)).not.toContain("WORKTREE:");
  });

  test("land retries an identical command after a null result", async () => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0), complete(1)],
      worktree: { [`wt-land:${ref}`]: [null, cleanLand] },
    });
    const prompts = log.prompts.filter((_, i) => log.labels[i] === `wt-land:${ref}`);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]);
    expect(prompts[0]).toContain(`land ${ref} --expect f0 --op a1-land --repo /abs/repo --slug my-plan`);
    expect(modelsFor(log, `wt-land:${ref}`)).toEqual(["haiku", "opus"]);
    expect(log.result.completed).toEqual([ref]);
  });

  test.each([null, THROWS])("land double failure keeps its worktree: %s", async (failure) => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0)],
      worktree: { [`wt-land:${ref}`]: [failure, failure] },
    });
    expect(callsTo(log.labels, `wt-land:${ref}`)).toBe(2);
    expect(log.result.escalations[0]).toMatchObject({ task: ref, attempt: 1, infrastructure: true });
    expect(log.result.escalations[0].reason).toEndWith(`Worktree kept at /wt/${ref}`);
    expect(promptFor(log, `block:${ref}`)).toContain(`Worktree kept at /wt/${ref}`);
    expect(log.labels).not.toContain(`done:${ref}`);
    expect(log.labels).not.toContain(`wt-remove:${ref}`);
    expect(log.result.worktrees).toEqual([{ ref, path: `/wt/${ref}` }]);
  });

  test("conflict rebases once and retries the full pipeline in the same worktree", async () => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0), complete(1)],
      worktree: { [`wt-land:${ref}`]: [
        { ...cleanLand, status: "conflict", files: ["src/a.ts", "src/b.ts"] },
        cleanLand,
      ] },
    });
    expect(log.labels).toEqual([
      "scout-wave-1", "wt-sweep:start", "wt-leak:baseline",
      `wt-create:${ref}`, `dev:${ref}#1`, `verify:${ref}#1`, `judge:${ref}#1`,
      `wt-land:${ref}`, `wt-rebase:${ref}`,
      `dev:${ref}#2`, `verify:${ref}#2`, `judge:${ref}#2`,
      `wt-land:${ref}`, `done:${ref}`, `wt-remove:${ref}`, "wt-leak:1",
      "scout-wave-2", "wt-sweep:end", "commit-post-loop",
    ]);
    expect(promptFor(log, `wt-rebase:${ref}`)).toContain(
      `rebase ${ref} --op a1-rebase --repo /abs/repo --slug my-plan`,
    );
    const lands = log.prompts.filter((_, i) => log.labels[i] === `wt-land:${ref}`);
    expect(lands[0]).toContain("--expect f0 --op a1-land");
    expect(lands[1]).toContain("--expect f0 --op a2-land");
    expect(promptFor(log, `dev:${ref}#2`)).toContain("LAND CONFLICT:\nsrc/a.ts\nsrc/b.ts");
    for (const role of ["dev", "verify", "judge"]) {
      expect(promptFor(log, `${role}:${ref}#2`)).toContain(`WORKTREE: /wt/${ref}`);
    }
    expect(callsTo(log.labels, `wt-create:${ref}`)).toBe(1);
    const schema = log.schemas[log.labels.indexOf(`wt-rebase:${ref}`)]!;
    expect(schema.required).toEqual(["path", "base", "conflicted"]);
    expect(schema.properties!.path.type).toBe("string");
    expect(schema.properties!.base.type).toBe("string");
    expect(schema.properties!.conflicted.items!.type).toBe("string");
    expect(log.result.completed).toEqual([ref]);
    expect(log.result.worktrees).toEqual([]);
  });

  test.each(["conflict", "verify"])("%s until the cap parks and reports the kept worktree", async (failure) => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0), snapshot({
        counts: counts({ total: 1, blocked: 1 }),
        unfinished: [{ ref, state: "blocked" }],
      })],
      ...(failure === "conflict" ? {
        worktree: { [`wt-land:${ref}`]: Array.from({ length: 3 }, () => ({
          ...cleanLand, status: "conflict", files: ["src/a.ts", "src/b.ts"],
        })) },
      } : {
        gate: { [ref]: Array.from({ length: 3 }, () => ({ passed: false, summary: "red" })) },
      }),
    }, { maxAttempts: "3", lastShotEngine: "null" });
    expect(log.result.escalations).toHaveLength(1);
    expect(log.result.escalations[0]).toMatchObject({
      task: ref, attempt: 3, infrastructure: false, parked: true,
    });
    expect(log.result.escalations[0].reason).toEndWith(`Worktree kept at /wt/${ref}`);
    expect(promptFor(log, `block:${ref}`)).toContain(`Worktree kept at /wt/${ref}`);
    expect(log.labels).not.toContain(`done:${ref}`);
    expect(log.labels).not.toContain(`wt-remove:${ref}`);
    expect(callsTo(log.labels, `wt-create:${ref}`)).toBe(1);
    expect(callsTo(log.labels, `wt-land:${ref}`)).toBe(failure === "conflict" ? 3 : 0);
    expect(callsTo(log.labels, `wt-rebase:${ref}`)).toBe(failure === "conflict" ? 3 : 0);
    expect(log.result.completed).toEqual([]);
    expect(log.result.worktrees).toEqual([{ ref, path: `/wt/${ref}` }]);
    expect(promptFor(log, "wt-sweep:end")).toContain(`--keep ${ref}`);
  });

  test("rebase retries an identical command after a null result", async () => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0), complete(1)],
      worktree: {
        [`wt-land:${ref}`]: [{ ...cleanLand, status: "conflict", files: ["src/a.ts"] }],
        [`wt-rebase:${ref}`]: [null, { path: `/wt/${ref}`, base: "b2", conflicted: ["src/a.ts"] }],
      },
    });
    const prompts = log.prompts.filter((_, i) => log.labels[i] === `wt-rebase:${ref}`);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]);
    expect(prompts[0]).toContain("--op a1-rebase");
    expect(modelsFor(log, `wt-rebase:${ref}`)).toEqual(["haiku", "opus"]);
    expect(log.labels).toContain(`dev:${ref}#2`);
    expect(log.result.completed).toEqual([ref]);
  });

  test.each([null, THROWS])("rebase double failure parks with its cause and kept path: %s", async (failure) => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0)],
      worktree: {
        [`wt-land:${ref}`]: [{ ...cleanLand, status: "conflict", files: ["src/a.ts"] }],
        [`wt-rebase:${ref}`]: [failure, failure],
      },
    });
    expect(callsTo(log.labels, `wt-rebase:${ref}`)).toBe(2);
    expect(log.result.escalations[0]).toMatchObject({ task: ref, attempt: 1, infrastructure: true, parked: true });
    expect(log.result.escalations[0].reason).toStartWith("worktree rebase failed:");
    expect(log.result.escalations[0].reason).toEndWith(`Worktree kept at /wt/${ref}`);
    expect(promptFor(log, `block:${ref}`)).toContain(`Worktree kept at /wt/${ref}`);
    expect(log.labels).not.toContain(`dev:${ref}#2`);
    expect(log.labels).not.toContain(`done:${ref}`);
    expect(log.labels).not.toContain(`wt-remove:${ref}`);
    expect(log.result.worktrees).toEqual([{ ref, path: `/wt/${ref}` }]);
  });

  test("a land leak stops a sibling waiting for the main-tree lock", async () => {
    const log = await runOrchestrator({
      scouts: [multiWave([ref, "ui/02"])],
      worktree: { [`wt-land:${ref}`]: [{
        ...cleanLand, status: "leak", paths: ["x.ts"],
      }] },
    });
    expect(log.result.escalations[0]).toMatchObject({ task: ref, infrastructure: true, parked: false });
    expect(log.result.escalations[0].reason).toStartWith("run aborted:");
    expect(log.result.escalations[0].reason).toEndWith(`Worktree kept at /wt/${ref}`);
    expect(log.result.aborted?.paths).toEqual(["x.ts"]);
    expect(log.labels).toContain("judge:ui/02#1");
    expect(log.labels).not.toContain("wt-land:ui/02");
    for (const task of [ref, "ui/02"]) {
      for (const role of ["block", "done", "wt-remove"]) {
        expect(log.labels).not.toContain(`${role}:${task}`);
      }
    }
    expect(log.result.completed).toEqual([]);
    expect(log.result.worktrees).toEqual([
      { ref, path: `/wt/${ref}` }, { ref: "ui/02", path: "/wt/ui/02" },
    ]);
    expect(log.labels).not.toContain("wt-sweep:end");
    expect(log.labels.some((label) => label.startsWith("commit-"))).toBe(false);
  });

  test("drift pass re-verifies the main tree before completing", async () => {
    const log = await runOrchestrator({
      scouts: [multiWave([ref, "ui/02"]), complete(2)],
      worktree: { [`wt-land:${ref}`]: [{ ...cleanLand, drift: true }] },
    });
    const labels = log.labels.filter((label) => label.includes(ref));
    expect(labels.slice(labels.indexOf(`wt-land:${ref}`))).toEqual([
      `wt-land:${ref}`, `reverify:${ref}#1`, `done:${ref}`, `wt-remove:${ref}`,
    ]);
    expect(log.result.completed).toContain(ref);
    const prompt = promptFor(log, `reverify:${ref}#1`);
    expect(prompt).not.toContain("WORKTREE:");
    expect(prompt).not.toContain(`/wt/${ref}`);
    expect(prompt).toContain("/abs/repo");
    expect(prompt).toContain("main tree changed after this task's snapshot");
    expect(prompt).toContain("--role reverify");
    expect(prompt).toContain("PASS or FAIL");
    expect(log.schemas[log.labels.indexOf(`reverify:${ref}#1`)]).toEqual(
      log.schemas[log.labels.indexOf(`verify:${ref}#1`)],
    );
    expect(promptFor(log, "wt-land:ui/02")).toContain("--expect landed");
  });

  test("drift fail unlands and rebases before a new dev attempt", async () => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0), complete(1)],
      worktree: {
        [`wt-land:${ref}`]: [{ ...cleanLand, drift: true }],
        [`wt-unland:${ref}`]: [null],
        [`wt-rebase:${ref}`]: [THROWS],
      },
      reverify: { [ref]: [{ passed: false, summary: "merged test broke" }] },
    });
    const start = log.labels.indexOf(`reverify:${ref}#1`);
    expect(log.labels.slice(start, start + 6)).toEqual([
      `reverify:${ref}#1`, `wt-unland:${ref}`, `wt-unland:${ref}`,
      `wt-rebase:${ref}`, `wt-rebase:${ref}`, `dev:${ref}#2`,
    ]);
    for (const role of ["unland", "rebase"]) {
      const prompts = log.prompts.filter((_, i) => log.labels[i] === `wt-${role}:${ref}`);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toBe(prompts[1]);
      expect(prompts[0]).toContain(`--op a1-${role}`);
    }
    expect(promptFor(log, `dev:${ref}#2`)).toContain("REVERIFY FAIL:");
    expect(promptFor(log, `dev:${ref}#2`)).toContain("merged test broke");
    expect(log.labels.indexOf(`done:${ref}`)).toBeGreaterThan(log.labels.indexOf(`dev:${ref}#2`));
    const lands = log.prompts.filter((_, i) => log.labels[i] === `wt-land:${ref}`);
    expect(lands[1]).toContain("--expect f0 --op a2-land");
    expect(log.result.completed).toEqual([ref]);
  });

  test("drift null twice undoes the land and parks with its worktree", async () => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0)],
      worktree: { [`wt-land:${ref}`]: [{ ...cleanLand, drift: true }] },
      reverify: { [ref]: [null, null] },
    });
    const start = log.labels.indexOf(`reverify:${ref}#1`);
    expect(log.labels.slice(start, start + 4)).toEqual([
      `reverify:${ref}#1`, `reverify:${ref}#1`, `wt-unland:${ref}`, `block:${ref}`,
    ]);
    expect(log.models[start + 1]).toBe("opus");
    expect(log.efforts[start + 1]).toBe("medium");
    expect(log.prompts[start]).toBe(log.prompts[start + 1]);
    for (const label of [`wt-rebase:${ref}`, `dev:${ref}#2`, `done:${ref}`, `wt-remove:${ref}`]) {
      expect(log.labels).not.toContain(label);
    }
    expect(promptFor(log, `wt-unland:${ref}`)).toContain("--op a1-unland");
    expect(log.result.escalations[0]).toMatchObject({ task: ref, attempt: 1, infrastructure: true, parked: true });
    expect(log.result.escalations[0].reason).toContain("drift re-verify");
    expect(log.result.escalations[0].reason).toContain("land was undone");
    expect(log.result.worktrees).toEqual([{ ref, path: `/wt/${ref}` }]);
  });

  test("drift null then pass retries the same prompt and completes", async () => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0), complete(1)],
      worktree: { [`wt-land:${ref}`]: [{ ...cleanLand, drift: true }] },
      reverify: { [ref]: [null, { passed: true, summary: "green on retry" }] },
    });
    const start = log.labels.indexOf(`reverify:${ref}#1`);
    expect(log.labels.slice(start, start + 4)).toEqual([
      `reverify:${ref}#1`, `reverify:${ref}#1`, `done:${ref}`, `wt-remove:${ref}`,
    ]);
    expect(log.models[start + 1]).toBe("opus");
    expect(log.efforts[start + 1]).toBe("medium");
    expect(log.prompts[start]).toBe(log.prompts[start + 1]);
    expect(log.labels).not.toContain(`wt-unland:${ref}`);
    expect(log.result.completed).toEqual([ref]);
  });

  test.each([
    ["verify=sonnet/high", "sonnet", "high"],
    [null, "opus", "low"],
  ])("drift model follows the verify role: %s", async (modelsRaw, model, effort) => {
    const log = await runOrchestrator({
      scouts: [snapshot({ ready: [ready(ref, false, modelsRaw)], counts: counts({ total: 1, todo: 1 }) }), complete(1)],
      worktree: { [`wt-land:${ref}`]: [{ ...cleanLand, drift: true }] },
    });
    expect(modelFor(log, `reverify:${ref}#1`)).toBe(model!);
    expect(effortFor(log, `reverify:${ref}#1`)).toBe(effort!);
  });

  test.each(["reverify", "wt-unland", "wt-rebase"])(
    "drift holds the main-tree lock during %s", async (heldRole) => {
      const held = latch();
      const sibling = latch();
      const calls: string[] = [];
      const heldLabel = heldRole === "reverify" ? `reverify:${ref}#1` : `${heldRole}:${ref}`;
      const run = runOrchestrator({
        scouts: [multiWave([ref, "ui/02"]), complete(2)],
        agentCalls: calls,
        devHolds: { "ui/02": sibling.held },
        reverifyHolds: heldRole === "reverify" ? { [ref]: held.held } : {},
        worktreeHolds: heldRole === "reverify" ? {} : { [heldLabel]: held.held },
        worktree: { [`wt-land:${ref}`]: [{ ...cleanLand, drift: true }] },
        reverify: { [ref]: [{ passed: heldRole === "reverify", summary: "merged verification" }] },
      });
      try {
        await waitForCall(calls, heldLabel);
        sibling.release();
        await waitForCall(calls, "judge:ui/02#1");
        expect(calls).not.toContain("wt-land:ui/02");
        expect(calls).not.toContain(`done:${ref}`);
      } finally {
        sibling.release();
        held.release();
      }
      const log = await run;
      expect(log.result.completed).toContain(ref);
      expect(log.result.completed).toContain("ui/02");
    },
  );

  test("drift re-verify retains the Max parallel slot", async () => {
    const held = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: [snapshot({
        ready: [ready(ref), ready("ui/02")],
        counts: counts({ total: 2, todo: 2 }),
        unfinished: [{ ref, state: "todo" }, { ref: "ui/02", state: "todo" }],
        maxParallel: 1,
      }), complete(2)],
      agentCalls: calls,
      reverifyHolds: { [ref]: held.held },
      worktree: { [`wt-land:${ref}`]: [{ ...cleanLand, drift: true }] },
    });
    try {
      await waitForCall(calls, `reverify:${ref}#1`);
      expect(calls).not.toContain("wt-create:ui/02");
      expect(calls).not.toContain(`done:${ref}`);
    } finally {
      held.release();
    }
    expect((await run).result.completed).toEqual([ref, "ui/02"]);
  });

  test("drift failure on the final attempt parks and keeps the worktree", async () => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0)],
      worktree: { [`wt-land:${ref}`]: [{ ...cleanLand, drift: true }] },
      reverify: { [ref]: [{ passed: false, summary: "merged test broke" }] },
    }, { maxAttempts: "1", lastShotEngine: "null" });
    expect(log.result.escalations[0]).toMatchObject({ attempt: 1, infrastructure: false, parked: true });
    expect(log.result.escalations[0].reason).toContain("REVERIFY FAIL:");
    expect(log.result.worktrees).toEqual([{ ref, path: `/wt/${ref}` }]);
    expect(log.labels).not.toContain(`done:${ref}`);
    expect(log.labels).not.toContain(`wt-remove:${ref}`);
  });

  test.each([null, THROWS])("failed mark-done after land never parks or unlands: %s", async (failure) => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0)], markDone: { [ref]: [failure, failure] },
    });
    expect(callsTo(log.labels, `done:${ref}`)).toBe(2);
    expect(log.labels).toContain(`wt-remove:${ref}`);
    expect(log.labels).not.toContain(`block:${ref}`);
    expect(log.labels.some((l) => l.startsWith("wt-unland:"))).toBe(false);
    expect(log.result.completed).toEqual([]);
    expect(log.result.escalations[0]).toMatchObject({ infrastructure: true, parked: false });
    expect(log.result.escalations[0].reason).toContain("landed, but Status was not marked done");
    expect(log.result.escalations[0].reason).toContain("mark-done.ts");
    expect(log.result.worktrees).toEqual([]);
  });

  test.each([false, true, null])("remove failure probes existence: %s", async (exists) => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0), complete(1)],
      worktree: {
        [`wt-remove:${ref}`]: [null, null],
        [`wt-show:${ref}`]: exists === null ? [null, null] : [{ path: `/wt/${ref}`, base: "b0", exists }],
      },
    });
    expect(log.result.completed).toEqual([ref]);
    expect(log.result.escalations).toEqual([]);
    expect(log.result.needsHuman).toEqual([]);
    expect(log.result.worktrees).toEqual([]);
    expect(log.result.cleanupFailures).toEqual(exists === false ? [] : [{ ref, path: `/wt/${ref}` }]);
    expect(promptFor(log, "wt-sweep:end")).not.toContain("--keep ");
    expect(callsTo(log.labels, `wt-remove:${ref}`)).toBe(2);
    expect(log.labels).toContain(`wt-show:${ref}`);
  });

  test("ordinary retries reuse one worktree and land with the passing attempt id", async () => {
    const log = await runOrchestrator({
      scouts: [wave(ref, 1, 0), complete(1)],
      gate: { [ref]: [{ passed: false, summary: "red" }] },
      judge: { [ref]: [{ verdict: fail, rationale: "fix it" }] },
    });
    expect(callsTo(log.labels, `wt-create:${ref}`)).toBe(1);
    expect(promptFor(log, `wt-land:${ref}`)).toContain("--op a3-land");
    expect(log.result.completed).toEqual([ref]);
  });

  test("the next land reads the fingerprint assigned by the prior clean land", async () => {
    const log = await runOrchestrator({
      scouts: [multiWave([ref, "ui/02"]), complete(2)],
      worktree: { [`wt-land:${ref}`]: [cleanLand] },
    });
    expect(promptFor(log, "wt-land:ui/02")).toContain("--expect landed");
  });

  test("final review stays in the main tree while run sweeps still execute", async () => {
    const log = await runOrchestrator({ scouts: [snapshot({
      ready: [ready("review/01", true)],
      counts: counts({ total: 1, todo: 1 }),
      unfinished: [{ ref: "review/01", state: "todo" }],
    }), complete(1)] });
    expect(log.labels.filter((l) => l.startsWith("wt-"))).toEqual([
      "wt-sweep:start", "wt-leak:baseline", "wt-sweep:end",
    ]);
    expect(log.prompts.every((p) => !p.includes("WORKTREE:"))).toBe(true);
  });

  test("sweeps retain blocked leftovers without dispatching them", async () => {
    const log = await runOrchestrator({
      scouts: [blockedWave(), blockedEnd()],
      worktree: { "wt-sweep:start": [{ removed: [], kept: [kept] }] },
    });
    expect(promptFor(log, "wt-sweep:start")).toContain(`sweep --keep ${kept.ref} --repo`);
    expect(promptFor(log, "wt-sweep:end")).toContain(`sweep --keep ${kept.ref} --repo`);
    expect(log.result.worktrees).toEqual([kept]);
    expect(log.labels).not.toContain(`wt-create:${kept.ref}`);
  });

  test("first scout failure lists every worktree without sweeping", async () => {
    const log = await runOrchestrator({
      scouts: [null],
      worktree: { "wt-sweep:list": [{ removed: [], kept: [kept] }] },
    });
    expect(log.labels.filter((l) => l.startsWith("wt-"))).toEqual(["wt-sweep:list"]);
    expect(promptFor(log, "wt-sweep:list")).toContain("sweep --keep-all");
    expect(log.result.worktrees).toEqual([kept]);
  });

  test("later scout failure skips the end sweep and preserves startKept", async () => {
    const log = await runOrchestrator({
      scouts: [blockedWave(), null],
      worktree: { "wt-sweep:start": [{ removed: [], kept: [kept] }] },
    });
    expect(log.labels).not.toContain("wt-sweep:end");
    expect(log.result.worktrees).toEqual([kept]);
  });

  test.each(["wt-sweep:start", "wt-leak:baseline", "wt-sweep:end", "wt-sweep:list"])("run-scoped double failure stops with its cause: %s", async (label) => {
    const log = await runOrchestrator({
      scouts: label === "wt-sweep:list" ? [null] : [wave(ref, 1, 0), complete(1)],
      worktree: { [label]: [null, null] },
    });
    expect(callsTo(log.labels, label)).toBe(2);
    expect(log.result.escalations.some((e) => e.infrastructure && e.reason.includes(label))).toBe(true);
    if (label !== "wt-sweep:end") expect(log.labels).not.toContain(`wt-create:${ref}`);
  });

  test("failed create reports infrastructure failure and lets its sibling run", async () => {
    const log = await runOrchestrator({
      scouts: [multiWave([ref, "ui/02"]), complete(2)],
      worktree: { [`wt-create:${ref}`]: [null, null] },
    });
    expect(log.result.completed).toEqual(["ui/02"]);
    expect(log.result.escalations[0]).toMatchObject({ task: ref, attempt: 1, infrastructure: true });
    expect(log.labels).not.toContain(`dev:${ref}#1`);
    expect(log.result.escalations[0].reason).not.toContain("Worktree kept at");
    expect(promptFor(log, `block:${ref}`)).not.toContain("Worktree kept at");
  });

  test("a held rebase blocks a sibling land until the main-tree lock is released", async () => {
    const rebase = latch();
    const sibling = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: [multiWave([ref, "ui/02"]), complete(2)],
      agentCalls: calls,
      devHolds: { "ui/02": sibling.held },
      worktreeHolds: { [`wt-rebase:${ref}`]: rebase.held },
      worktree: { [`wt-land:${ref}`]: [{
        ...cleanLand, status: "conflict", files: ["src/a.ts"],
      }] },
    });
    try {
      await waitForCall(calls, `wt-rebase:${ref}`);
      sibling.release();
      await waitForCall(calls, "judge:ui/02#1");
      expect(calls).not.toContain("wt-land:ui/02");
    } finally {
      sibling.release();
      rebase.release();
    }
    const log = await run;
    expect(log.result.completed).toEqual([ref, "ui/02"]);
    expect(log.labels).toContain("wt-land:ui/02");
  });

  test("a parked final review reports no worktree path", async () => {
    const log = await runOrchestrator({
      scouts: [snapshot({
        ready: [ready("review/01", true)],
        counts: counts({ total: 1, todo: 1 }),
        unfinished: [{ ref: "review/01", state: "todo" }],
      })],
      gate: { "review/01": [{ passed: false, summary: "red" }] },
    }, { finalReviewMaxAttempts: "1" });
    expect(log.result.escalations[0]).toMatchObject({ task: "review/01", parked: true });
    expect(log.result.escalations[0].reason).not.toContain("Worktree kept at");
    expect(promptFor(log, "block:review/01")).not.toContain("Worktree kept at");
    expect(log.result.worktrees).toEqual([]);
  });

  test.each(["create", "land", "remove"])("a held land blocks another task's %s", async (operation) => {
    const land = latch();
    const writer = latch();
    const sibling = latch();
    const calls: string[] = [];
    const refs = operation === "create" ? [ref, "ui/02", "ui/03"] : [ref, "ui/02"];
    const run = runOrchestrator({
      scouts: [snapshot({
        ready: refs.map((r) => ready(r)),
        counts: counts({ total: refs.length, todo: refs.length }),
        unfinished: refs.map((ref) => ({ ref, state: "todo" })),
        maxParallel: 2,
      }), complete(refs.length)],
      agentCalls: calls,
      worktreeHolds: { [`wt-land:${ref}`]: land.held },
      ...(operation === "land" ? { devHolds: { "ui/02": sibling.held } } : {}),
      ...(operation === "remove" ? {
        devHolds: { [ref]: writer.held }, doneHolds: { "ui/02": sibling.held },
      } : {}),
      ...(operation === "create" ? {
        devHolds: { [ref]: writer.held },
        gate: { "ui/02": [null] }, parkHolds: { "ui/02": sibling.held },
      } : {}),
    });
    if (operation !== "land") {
      await waitForCall(calls, operation === "create" ? "block:ui/02" : "done:ui/02");
      writer.release();
    }
    await waitForCall(calls, `wt-land:${ref}`);
    sibling.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = `wt-${operation}:${operation === "create" ? "ui/03" : "ui/02"}`;
    expect(calls).not.toContain(next);
    land.release();
    const log = await run;
    expect(log.labels).toContain(next);
    expect(log.result.completed).toContain(ref);
  });
});

describe("WORKTREE-05 abort and kept-worktree resume", () => {
  const a = "ui/01";
  const b = "ui/02";
  const cleanLand = {
    status: "clean", drift: false, files: [], paths: [],
    fingerprint: "landed", previous: "f0",
  };
  const leak = { ...cleanLand, status: "leak", paths: ["src/leaked.ts"] };
  const cappedWave = (maxParallel: number) => snapshot({
    ready: [ready(a), ready(b)],
    counts: counts({ total: 2, todo: 2 }),
    unfinished: [{ ref: a, state: "todo" }, { ref: b, state: "todo" }],
    maxParallel,
  });
  const resume = {
    resumeTask: "'ui/01'",
    resumeTaskPath: "'/abs/repo/docs/my-plan/tasks/ui/01.md'",
    resumeAttempt: "3",
  };

  test("1. a land leak aborts a sibling queued behind Max parallel 1", async () => {
    const log = await runOrchestrator({
      scouts: [cappedWave(1), complete(2)],
      worktree: { [`wt-land:${a}`]: [leak] },
    });

    expect(log.labels).toContain(`wt-land:${a}`);
    for (const role of ["wt-create", "wt-land", "done", "block"]) {
      expect(log.labels).not.toContain(`${role}:${b}`);
    }
    expect(log.labels).not.toContain(`done:${a}`);
    expect(log.labels).not.toContain(`block:${a}`);
    expect(log.labels).not.toContain(`wt-remove:${a}`);
    expect(log.labels.some((label) => label.startsWith("commit-"))).toBe(false);
    expect(log.labels).not.toContain("wt-sweep:end");
    expect(log.labels).not.toContain("scout-wave-2");
    expect(log.result.aborted?.paths).toEqual(leak.paths);
    expect(log.result.aborted?.reason).toContain(a);
    expect(log.result.worktrees).toEqual([{ ref: a, path: `/wt/${a}` }]);
    for (const ref of [a, b]) {
      expect(log.result.escalations.find((entry) => entry.task === ref)).toMatchObject({
        infrastructure: true,
        parked: false,
        reason: expect.stringContaining(`run aborted: ${log.result.aborted?.reason}`),
      });
    }
  });

  test("2. a land leak keeps a sibling that is still in dev", async () => {
    const dev = latch();
    const land = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: [cappedWave(2), complete(2)],
      worktree: { [`wt-land:${a}`]: [leak] },
      worktreeHolds: { [`wt-land:${a}`]: land.held },
      devHolds: { [b]: dev.held },
      agentCalls: calls,
    });
    try {
      await waitForCall(calls, `dev:${b}#1`);
      await waitForCall(calls, `wt-land:${a}`);
      land.release();
      // Drain the released land's promise chain while the sibling stays in dev.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      land.release();
      dev.release();
    }
    const log = await run;

    for (const role of ["wt-land", "done", "block", "wt-remove"]) {
      expect(log.labels).not.toContain(`${role}:${b}`);
    }
    expect(log.labels).not.toContain(`block:${a}`);
    expect(log.result.aborted?.paths).toEqual(leak.paths);
    expect(log.result.worktrees).toEqual([
      { ref: a, path: `/wt/${a}` }, { ref: b, path: `/wt/${b}` },
    ]);
    expect(log.result.escalations.find((entry) => entry.task === b)).toMatchObject({
      infrastructure: true,
      parked: false,
      reason: expect.stringContaining(`run aborted: ${log.result.aborted?.reason}`),
    });
  });

  test("3. Final review waves and verify resumes are exempt from leak checks", async () => {
    const ref = "review/01";
    const log = await runOrchestrator({ scouts: [snapshot({
      ready: [ready(ref, true)],
      counts: counts({ total: 1, todo: 1 }),
      unfinished: [{ ref, state: "todo" }],
    }), complete(1)] });
    expect(log.labels).toContain("wt-leak:baseline");
    expect(log.labels).toContain(`fix:${ref}#1`);
    expect(log.labels.filter((label) => label.startsWith("wt-leak:"))).toEqual([
      "wt-leak:baseline",
    ]);

    const resumed = await runOrchestrator({ scouts: [] }, {
      resumeTask: "'review/01'",
      resumeTaskPath: "'/abs/repo/docs/my-plan/tasks/review/01.md'",
      resumeFinalReview: "true",
      resumeFrom: "'verify'",
    });
    expect(resumed.labels[0]).toBe(`verify:${ref}#1`);
    expect(resumed.labels.some((label) => /^(wt-leak:|wt-show:|wt-create:)/.test(label))).toBe(false);
    expect(resumed.result.completed).toEqual([ref]);
    expect(resumed.prompts.every((prompt) => !prompt.includes("WORKTREE:"))).toBe(true);
  });

  test("4. a wave-end leak stops commits and scouting and reports blocked leftovers", async () => {
    const kept = { ref: "old/01", path: "/old/worktree" };
    const log = await runOrchestrator({
      scouts: [snapshot({
        ready: [ready(a)],
        counts: counts({ total: 3, todo: 2, blocked: 1 }),
        unfinished: [
          { ref: a, state: "todo" }, { ref: b, state: "todo" },
          { ref: kept.ref, state: "blocked" },
        ],
      }), snapshot({
        ready: [ready(b)],
        counts: counts({ total: 3, done: 1, todo: 1, blocked: 1 }),
        unfinished: [{ ref: b, state: "todo" }, { ref: kept.ref, state: "blocked" }],
      })],
      worktree: {
        "wt-sweep:start": [{ removed: [], kept: [kept] }],
        [`wt-land:${a}`]: [cleanLand],
        "wt-leak:1": [{ fingerprint: "leaked", paths: leak.paths }],
      },
    });
    expect(log.labels).toContain(`done:${a}`);
    expect(log.labels).toContain(`wt-remove:${a}`);
    expect(log.labels).toContain("wt-leak:1");
    expect(log.labels.indexOf("wt-leak:1")).toBeGreaterThan(log.labels.indexOf(`wt-remove:${a}`));
    expect(promptFor(log, "wt-leak:1")).toContain("fingerprint --expect landed");
    expect(log.labels.some((label) => label.startsWith("commit-"))).toBe(false);
    expect(log.labels).not.toContain("scout-wave-2");
    expect(log.labels).not.toContain("wt-sweep:end");
    expect(log.result.aborted?.paths).toEqual(leak.paths);
    expect(log.result.aborted?.reason).toEqual(expect.any(String));
    expect(log.result.completed).toEqual([a]);
    expect(log.result.worktrees).toEqual([kept]);
  });

  test("5. verify resumes take a baseline then verify the kept worktree", async () => {
    const log = await runOrchestrator({
      scouts: [],
      worktree: { [`wt-show:${a}`]: [{ path: "/wt/x", base: "b0", exists: true }] },
    }, { ...resume, resumeFrom: "'verify'" });

    expect(log.labels.slice(0, 2)).toEqual(["wt-leak:resume", `wt-show:${a}`]);
    expect(log.labels).not.toContain(`wt-create:${a}`);
    expect(log.labels.some((label) => /^(scout-wave-|dev:)/.test(label))).toBe(false);
    expect(promptFor(log, `verify:${a}#3`)).toContain("WORKTREE: /wt/x");
    expect(promptFor(log, `judge:${a}#3`)).toContain("WORKTREE: /wt/x");
    expect(log.labels).toContain(`done:${a}`);
    expect(log.labels).toContain(`wt-remove:${a}`);
    expect(log.result.worktrees).toEqual([]);
  });

  test("6. judge resumes use the kept worktree and attestation without verifying", async () => {
    const attestation = "/abs/repo/docs/my-plan/.flightlog/attested.md";
    const log = await runOrchestrator({
      scouts: [],
      worktree: { [`wt-show:${a}`]: [{ path: "/wt/j", base: "b0", exists: true }] },
    }, { ...resume, resumeFrom: "'judge'", attestationFile: JSON.stringify(attestation) });

    expect(log.labels.slice(0, 3)).toEqual(["wt-leak:resume", `wt-show:${a}`, `judge:${a}#3`]);
    expect(log.labels).not.toContain(`wt-create:${a}`);
    expect(log.labels.some((label) => /^(verify:|dev:|scout-wave-)/.test(label))).toBe(false);
    expect(promptFor(log, `judge:${a}#3`)).toContain("WORKTREE: /wt/j");
    expect(promptFor(log, `judge:${a}#3`)).toContain(attestation);
  });

  test.each(["verify", "judge"])("7. a missing kept worktree halts a %s resume before agents", async (from) => {
    const path = "/wt/missing";
    const log = await runOrchestrator({
      scouts: [],
      worktree: { [`wt-show:${a}`]: [{ path, base: null, exists: false }] },
    }, {
      ...resume, resumeFrom: JSON.stringify(from),
      attestationFile: "'/abs/repo/attested.md'",
    });

    expect(log.labels.slice(0, 2)).toEqual(["wt-leak:resume", `wt-show:${a}`]);
    expect(log.labels.some((label) => /^(verify:|judge:|dev:|wt-create:)/.test(label))).toBe(false);
    expect(log.result.completed).toEqual([]);
    expect(log.result.escalations).toHaveLength(1);
    expect(log.result.escalations[0]).toMatchObject({ task: a, infrastructure: true });
    expect(log.result.escalations[0].reason).toContain(path);
    expect(log.result.escalations[0].reason).toContain("resume from dev");
  });

  test("8. resumed lands use the fresh resume fingerprint", async () => {
    const log = await runOrchestrator({
      scouts: [],
      worktree: { "wt-leak:resume": [{ fingerprint: "resume-fresh", paths: [] }] },
    }, { ...resume, resumeFrom: "'verify'" });

    expect(log.labels[0]).toBe("wt-leak:resume");
    expect(promptFor(log, "wt-leak:resume")).toContain("fingerprint --repo");
    expect(promptFor(log, "wt-leak:resume")).not.toContain("--expect");
    expect(promptFor(log, `wt-land:${a}`)).toContain("--expect resume-fresh");
    expect(log.result.completed).toEqual([a]);
  });

  test("9. a clean land finishes done and removal after a sibling aborts", async () => {
    const done = latch();
    const dev = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: [cappedWave(2), complete(2)],
      worktree: { [`wt-land:${a}`]: [cleanLand], [`wt-land:${b}`]: [leak] },
      doneHolds: { [a]: done.held },
      devHolds: { [b]: dev.held },
      agentCalls: calls,
    });
    try {
      await waitForCall(calls, `done:${a}`);
      dev.release();
      await waitForCall(calls, `wt-land:${b}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).not.toContain(`wt-remove:${a}`);
    } finally {
      dev.release();
      done.release();
    }
    const log = await run;

    expect(log.labels).toContain(`done:${a}`);
    expect(log.labels).toContain(`wt-remove:${a}`);
    expect(log.labels.indexOf(`wt-land:${a}`)).toBeLessThan(log.labels.indexOf(`wt-land:${b}`));
    expect(log.labels.indexOf(`wt-remove:${a}`)).toBeGreaterThan(log.labels.indexOf(`wt-land:${b}`));
    expect(log.labels).not.toContain(`done:${b}`);
    expect(log.labels).not.toContain(`block:${b}`);
    expect(log.labels).not.toContain(`wt-remove:${b}`);
    expect(log.labels.some((label) => label.startsWith("commit-"))).toBe(false);
    expect(log.labels).not.toContain("wt-sweep:end");
    expect(log.result.aborted?.reason).toContain(b);
    expect(log.result.aborted?.paths).toEqual(leak.paths);
    expect(log.result.completed).toEqual([a]);
    expect(log.result.worktrees).toEqual([{ ref: b, path: `/wt/${b}` }]);
  });

  test("10. dev resumes reuse an existing worktree", async () => {
    const log = await runOrchestrator({
      scouts: [],
      worktree: { [`wt-show:${a}`]: [{ path: "/wt/d", base: "b0", exists: true }] },
    }, { ...resume, resumeFrom: "'dev'" });

    expect(log.labels.slice(0, 2)).toEqual(["wt-leak:resume", `wt-show:${a}`]);
    expect(log.labels).not.toContain(`wt-create:${a}`);
    expect(promptFor(log, `dev:${a}#3`)).toContain("WORKTREE: /wt/d");
    expect(log.labels.some((label) => label.startsWith("scout-wave-"))).toBe(false);
  });

  test("11. dev resumes create a worktree only after show reports it missing", async () => {
    const log = await runOrchestrator({
      scouts: [],
      worktree: {
        [`wt-show:${a}`]: [{ path: "/wt/missing", base: null, exists: false }],
        [`wt-create:${a}`]: [{ path: "/wt/created", base: "fresh" }],
      },
    }, { ...resume, resumeFrom: "'dev'" });

    expect(log.labels.slice(0, 3)).toEqual(["wt-leak:resume", `wt-show:${a}`, `wt-create:${a}`]);
    expect(promptFor(log, `dev:${a}#3`)).toContain("WORKTREE: /wt/created");
    expect(log.result.completed).toEqual([a]);
  });

  test("an in-flight park never retries its Status edit after a sibling aborts", async () => {
    const land = latch();
    const park = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: [cappedWave(2)],
      worktree: { [`wt-land:${a}`]: [leak] },
      worktreeHolds: { [`wt-land:${a}`]: land.held },
      gate: { [b]: [{ passed: false, summary: "red" }] },
      park: { [b]: [THROWS, { ok: true, status: "blocked" }] },
      parkHolds: { [b]: park.held },
      agentCalls: calls,
    }, { maxAttempts: "1" });
    try {
      await waitForCall(calls, `block:${b}`);
      await waitForCall(calls, `wt-land:${a}`);
      land.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      land.release();
      park.release();
    }
    const log = await run;
    expect(log.labels.filter((label) => label === `block:${b}`)).toHaveLength(1);
    expect(log.result.escalations.find((entry) => entry.task === b)).toMatchObject({
      infrastructure: true, parked: false,
      reason: expect.stringContaining(`run aborted: ${log.result.aborted?.reason}`),
    });
    expect(log.labels).not.toContain(`wt-land:${b}`);
    expect(log.result.worktrees).toEqual([
      { ref: a, path: `/wt/${a}` }, { ref: b, path: `/wt/${b}` },
    ]);
  });

  test.each(["dev", "judge"])("Final review %s resumes stay in the main tree", async (from) => {
    const ref = "review/01";
    const log = await runOrchestrator({ scouts: [] }, {
      resumeTask: "'review/01'",
      resumeTaskPath: "'/abs/repo/docs/my-plan/tasks/review/01.md'",
      resumeFinalReview: "true",
      resumeFrom: JSON.stringify(from),
      attestationFile: "'/abs/repo/attested.md'",
    });
    expect(log.labels.some((label) => /^(wt-leak:|wt-show:|wt-create:)/.test(label))).toBe(false);
    expect(log.labels).toContain(from === "dev" ? `fix:${ref}#1` : `judge:${ref}#1`);
    expect(log.prompts.every((prompt) => !prompt.includes("WORKTREE:"))).toBe(true);
    expect(log.result.completed).toEqual([ref]);
  });

  test.each(["leak", "null"])("the first land abort survives a later %s wave check", async (later) => {
    const log = await runOrchestrator({
      scouts: [wave(a, 1, 0)],
      worktree: {
        [`wt-land:${a}`]: [leak],
        "wt-leak:1": later === "leak"
          ? [{ fingerprint: "later", paths: ["later.ts"] }]
          : [null, null],
      },
    });
    expect(log.labels).toContain("wt-leak:1");
    expect(log.result.aborted?.reason).toContain(a);
    expect(log.result.aborted?.paths).toEqual(leak.paths);
    expect(log.labels).not.toContain(`block:${a}`);
    expect(log.labels).not.toContain("wt-sweep:end");
    expect(log.labels.some((label) => label.startsWith("commit-"))).toBe(false);
  });

  test("a zero-pass wave checks for leaks before exiting and cannot commit a leak", async () => {
    const log = await runOrchestrator({
      scouts: [wave(a, 1, 0)],
      gate: { [a]: [{ passed: false, summary: "red" }] },
      worktree: { "wt-leak:1": [{ fingerprint: "leaked", paths: leak.paths }] },
    }, { maxAttempts: "1" });

    expect(log.result.completed).toEqual([]);
    expect(log.labels).toContain(`block:${a}`);
    expect(log.labels).toContain("wt-leak:1");
    expect(log.labels.indexOf("wt-leak:1")).toBeGreaterThan(log.labels.indexOf(`block:${a}`));
    expect(promptFor(log, "wt-leak:1")).toContain("fingerprint --expect f0");
    expect(log.result.aborted?.paths).toEqual(leak.paths);
    expect(log.labels.some((label) => label.startsWith("commit-"))).toBe(false);
    expect(log.labels).not.toContain("scout-wave-2");
    expect(log.labels).not.toContain("wt-sweep:end");
  });

  test("a double-null wave-end check aborts without a commit or end sweep", async () => {
    const log = await runOrchestrator({
      scouts: [wave(a, 1, 0), complete(1)],
      worktree: { "wt-leak:1": [null, null] },
    });

    expect(log.labels.filter((label) => label === "wt-leak:1")).toHaveLength(2);
    expect(log.result.aborted).toEqual({
      reason: "wave-end leak check returned no result", paths: [],
    });
    expect(log.labels.some((label) => label.startsWith("commit-"))).toBe(false);
    expect(log.labels).not.toContain("wt-sweep:end");
    expect(log.labels).not.toContain("scout-wave-2");
  });
});

describe("worktree contract boundaries", () => {
  test("mechanical schemas require every printed field, including nested kept entries", async () => {
    const log = await runOrchestrator({
      scouts: [wave("ui/01", 1, 0), complete(1)],
      worktree: { "wt-remove:ui/01": [null, null] },
    });
    const fields: Record<string, string[]> = {
      "wt-create": ["path", "base"],
      "wt-land": ["status", "drift", "files", "paths", "fingerprint", "previous"],
      "wt-remove": ["removed"],
      "wt-show": ["path", "base", "exists"],
      "wt-sweep": ["removed", "kept"],
      "wt-leak": ["fingerprint", "paths"],
    };
    for (const [index, label] of log.labels.entries()) {
      if (!label.startsWith("wt-")) continue;
      const schema = log.schemas[index]!;
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(fields[label.split(":")[0]]);
      expect(Object.keys(schema.properties!)).toEqual(schema.required!);
      if (label.startsWith("wt-land:")) {
        expect(schema.properties!.status.enum).toEqual(["clean", "conflict", "leak"]);
        expect(schema.properties!.drift.type).toBe("boolean");
        expect(schema.properties!.files.items!.type).toBe("string");
        expect(schema.properties!.paths.items!.type).toBe("string");
      }
      if (label.startsWith("wt-show:")) expect(schema.properties!.base.type).toEqual(["string", "null"]);
      if (label.startsWith("wt-sweep:")) expect(schema.properties!.kept.items!.required).toEqual(["ref", "path"]);
    }
  });

  test("a missing remove result recovered on retry needs no show or cleanup report", async () => {
    const log = await runOrchestrator({
      scouts: [wave("ui/01", 1, 0), complete(1)],
      worktree: { "wt-remove:ui/01": [null, { removed: false }] },
    });
    expect(log.result.completed).toEqual(["ui/01"]);
    expect(log.result.cleanupFailures).toEqual([]);
    expect(log.result.worktrees).toEqual([]);
    expect(log.labels).not.toContain("wt-show:ui/01");
  });

  test("kept worktrees are sorted, deduplicated, and never derived from end sweep output", async () => {
    const log = await runOrchestrator({
      scouts: [snapshot({
        ready: [ready("z/01")],
        counts: counts({ total: 3, todo: 1, blocked: 2 }),
        unfinished: [
          { ref: "z/01", state: "todo" },
          { ref: "a/01", state: "blocked" },
          { ref: "b/01", state: "blocked" },
        ],
      })],
      gate: { "z/01": [null] },
      worktree: {
        "wt-sweep:start": [{ removed: [], kept: [
          { ref: "b/01", path: "/wt/b/01" },
          { ref: "a/01", path: "/wt/a/01" },
          { ref: "a/01", path: "/wt/a/01" },
        ] }],
        "wt-sweep:end": [{ removed: [], kept: [{ ref: "fake/01", path: "/fake" }] }],
      },
    });
    expect(log.result.worktrees).toEqual([
      { ref: "a/01", path: "/wt/a/01" },
      { ref: "b/01", path: "/wt/b/01" },
      { ref: "z/01", path: "/wt/z/01" },
    ]);
    expect(promptFor(log, "wt-sweep:end")).toContain("--keep a/01,b/01,z/01");
  });

  test("a leftover no longer blocked is removed from the end keep list and report", async () => {
    const log = await runOrchestrator({
      scouts: [snapshot({
        ready: [ready("ui/01")],
        counts: counts({ total: 2, todo: 1, blocked: 1 }),
        unfinished: [{ ref: "ui/01", state: "todo" }, { ref: "old/01", state: "blocked" }],
      }), complete(2)],
    });
    expect(promptFor(log, "wt-sweep:start")).toContain("--keep old/01");
    expect(promptFor(log, "wt-sweep:end")).not.toContain("--keep ");
    expect(log.result.worktrees).toEqual([]);
  });

  test("cleanup failures stay sorted and separate even after the end sweep succeeds", async () => {
    const log = await runOrchestrator({
      scouts: [multiWave(["z/01", "a/01"]), complete(2)],
      worktree: {
        "wt-remove:z/01": [null, null],
        "wt-remove:a/01": [null, null],
        "wt-sweep:end": [{ removed: ["z/01", "a/01"], kept: [] }],
      },
    });
    expect(log.result.cleanupFailures).toEqual([
      { ref: "a/01", path: "/wt/a/01" }, { ref: "z/01", path: "/wt/z/01" },
    ]);
    expect(log.result.worktrees).toEqual([]);
    expect(log.result.escalations).toEqual([]);
    expect(log.result.completed).toEqual(["z/01", "a/01"]);
  });

  test("the parallel slot includes removal after a successful land", async () => {
    const removal = latch();
    const calls: string[] = [];
    const run = runOrchestrator({
      scouts: [snapshot({
        ready: [ready("ui/01"), ready("ui/02")],
        counts: counts({ total: 2, todo: 2 }),
        unfinished: [{ ref: "ui/01", state: "todo" }, { ref: "ui/02", state: "todo" }],
        maxParallel: 1,
      }), complete(2)],
      agentCalls: calls,
      worktreeHolds: { "wt-remove:ui/01": removal.held },
    });
    await waitForCall(calls, "wt-remove:ui/01");
    expect(calls).not.toContain("wt-create:ui/02");
    removal.release();
    expect((await run).result.completed).toEqual(["ui/01", "ui/02"]);
  });
});
