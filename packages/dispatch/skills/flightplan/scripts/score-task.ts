#!/usr/bin/env bun
/**
 * Score a flightplan task against its own `## Eval rubric`.
 *
 * The rubric is the graded layer on top of the binary Acceptance criteria gate.
 * A judge agent (or a human) supplies a 0–scaleMax score per dimension; this
 * script applies the rubric's weighting and hard-fail veto and returns a
 * deterministic pass/fail — the gate a workflow loops against.
 *
 * Weighted average = Σ(score × weight) ÷ Σ(weight)  (on the 0–scaleMax scale).
 * Pass = average meets the threshold AND no hard-fail veto AND every dimension
 * was scored.
 *
 * Usage:
 *   bun score-task.ts <task-file> <scores.json> [--json] [--log <file>] [--attempt N] [--agent <label>]
 *     scores.json: { "Correctness": 5, "Test coverage": 4, ... } keyed by dimension name
 *     --json: print the machine gate verdict only:
 *             {"weighted":number,"passed":boolean,"hardFailed":boolean,"missing":string[]}
 *     --log <file>: append the verdict to a flightlog JSONL trail (auto-creates
 *                   the dir + a self-ignore when logging into `.flightlog/`).
 *     --attempt / --agent: metadata stamped onto the logged entry.
 *
 * Exits 0 if passed, 1 if not, 2 on usage / unparseable-rubric errors.
 */
import { readFile } from "node:fs/promises";
import { parseTask, refToString, type Rubric } from "./lib/parse-task";
import { appendEntry, type ScoreEntry } from "./lib/flightlog";

export type DimensionScore = {
  name: string;
  weight: number;
  score: number;
  /** score × weight — the dimension's contribution to the weighted sum. */
  contribution: number;
};

export type ScoreResult = {
  /** Weighted average on the 0–scaleMax scale. */
  weighted: number;
  passThreshold: number;
  passOp: ">" | ">=";
  /** True only if the average meets the line, no veto fired, nothing missing. */
  passed: boolean;
  /** True if the rubric's hard-fail dimension is at/below its veto value. */
  hardFailed: boolean;
  breakdown: DimensionScore[];
  /** Dimensions declared by the rubric but absent from the scores input. */
  missing: string[];
};

export type ScoreJsonResult = Pick<
  ScoreResult,
  "weighted" | "passed" | "hardFailed" | "missing"
>;

export function toJsonResult(result: ScoreResult): ScoreJsonResult {
  return {
    weighted: result.weighted,
    passed: result.passed,
    hardFailed: result.hardFailed,
    missing: result.missing,
  };
}

/** Apply a rubric's weighting + hard-fail veto to a set of per-dimension scores. */
export function scoreTask(
  rubric: Rubric,
  scores: Record<string, number>,
): ScoreResult {
  const breakdown: DimensionScore[] = [];
  const missing: string[] = [];
  let weightSum = 0;
  let acc = 0;

  for (const d of rubric.dimensions) {
    const has = Object.prototype.hasOwnProperty.call(scores, d.name);
    if (!has) missing.push(d.name);
    const score = has ? scores[d.name] : 0;
    weightSum += d.weight;
    acc += score * d.weight;
    breakdown.push({
      name: d.name,
      weight: d.weight,
      score,
      contribution: score * d.weight,
    });
  }

  const weighted = weightSum > 0 ? acc / weightSum : 0;

  let hardFailed = false;
  if (rubric.hardFail) {
    const hv = scores[rubric.hardFail.dimension];
    if (typeof hv === "number") {
      hardFailed =
        rubric.hardFail.op === "<"
          ? hv < rubric.hardFail.value
          : hv <= rubric.hardFail.value;
    }
  }

  const meetsThreshold =
    rubric.passOp === ">"
      ? weighted > rubric.passThreshold
      : weighted >= rubric.passThreshold;

  const passed = meetsThreshold && !hardFailed && missing.length === 0;

  return {
    weighted,
    passThreshold: rubric.passThreshold,
    passOp: rubric.passOp,
    passed,
    hardFailed,
    breakdown,
    missing,
  };
}

/** Build a flightlog score entry from a verdict + run metadata (pure). */
export function buildScoreEntry(
  result: ScoreResult,
  meta: { task: string; ts: string; attempt?: number; agentLabel?: string },
): ScoreEntry {
  return {
    kind: "score",
    ts: meta.ts,
    task: meta.task,
    attempt: meta.attempt ?? 1,
    agentLabel: meta.agentLabel,
    weighted: result.weighted,
    passed: result.passed,
    hardFailed: result.hardFailed,
    missing: result.missing,
    threshold: result.passThreshold,
    passOp: result.passOp,
    breakdown: result.breakdown.map((d) => ({
      name: d.name,
      weight: d.weight,
      score: d.score,
    })),
  };
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes("--json");
  const positional = argv.filter(
    (a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"),
  );
  const [taskFile, scoresFile] = positional;
  const logFile = flagValue(argv, "--log");
  const attemptRaw = flagValue(argv, "--attempt");
  const agentLabel = flagValue(argv, "--agent");
  if (!taskFile || !scoresFile) {
    console.error(
      "Usage: bun score-task.ts <task-file> <scores.json> [--json] [--log <file>] [--attempt N] [--agent <label>]",
    );
    process.exit(2);
  }

  const content = await readFile(taskFile, "utf-8");
  const parsed = parseTask(content);
  if (!parsed.ok) {
    console.error(`Cannot parse task file: ${parsed.reason}`);
    process.exit(2);
  }
  if (!parsed.task.rubric) {
    console.error(
      "Task has no parseable `## Eval rubric` — run lint-task.ts to see why.",
    );
    process.exit(2);
  }

  let scores: Record<string, number>;
  try {
    scores = JSON.parse(await readFile(scoresFile, "utf-8"));
  } catch (err) {
    console.error(`Cannot read scores JSON: ${(err as Error).message}`);
    process.exit(2);
  }

  const result = scoreTask(parsed.task.rubric, scores);

  if (logFile) {
    const entry = buildScoreEntry(result, {
      task: refToString(parsed.task),
      ts: new Date().toISOString(),
      attempt: attemptRaw ? parseInt(attemptRaw, 10) : undefined,
      agentLabel,
    });
    await appendEntry(logFile, entry);
  }

  console.log(
    JSON.stringify(jsonMode ? toJsonResult(result) : result, null, 2),
  );
  process.exit(result.passed ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("score-task error:", err.message);
    process.exit(2);
  });
}
