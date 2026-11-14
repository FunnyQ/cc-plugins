import { createHash } from "node:crypto";
import { findReady } from "../next-ready";
import type {
  EscalationEntry,
  FlightEntry,
  FlightlogEntry,
  NoteEntry,
  RepairEntry,
  RepairVerdict,
  RunEndEntry,
  ScoreEntry,
} from "./flightlog";
import {
  GATE_SECTIONS,
  matchStatusLine,
  parseRubric,
  type ParsedTask,
  type Rubric,
} from "./parse-task";

export const TASK_REPAIR_CAP = 3;
export const FLIGHT_REPAIR_CAP = 10;

const COUNTED: ReadonlySet<RepairVerdict> = new Set([
  "fix",
  "defer",
  "not-plan",
  "infra-retry",
]);

const VERIFY_SECTIONS = new Set([
  "Verification",
  "Acceptance criteria",
  "Eval rubric",
]);

const GUARD_LIMIT =
  "The goal guard rejects careless gate edits, not deliberate ones; each gate change below was approved by an independent reviewer.";

export function goalSection(planMd: string): string {
  const lines = planMd.split("\n");
  const start = lines.findIndex((l) => /^##\s+Goals?\s*$/.test(l));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

export function goalHash(planMd: string): string {
  return createHash("sha256").update(goalSection(planMd)).digest("hex");
}

export function currentFlight(
  entries: FlightlogEntry[],
): { flight: FlightEntry; entries: FlightlogEntry[] } | null {
  const at = entries.findLastIndex((e) => e.kind === "flight");
  if (at === -1) return null;
  return {
    flight: entries[at] as FlightEntry,
    entries: entries.slice(at + 1),
  };
}

const repairsIn = (entries: FlightlogEntry[]): RepairEntry[] =>
  entries.filter((e): e is RepairEntry => e.kind === "repair");

export function repairCounts(flightEntries: FlightlogEntry[]): {
  flight: number;
  byTask: Record<string, number>;
} {
  const byTask: Record<string, number> = {};
  let flight = 0;
  for (const r of repairsIn(flightEntries)) {
    if (!COUNTED.has(r.verdict)) continue;
    flight += 1;
    byTask[r.task] = (byTask[r.task] ?? 0) + 1;
  }
  return { flight, byTask };
}

export type FlightStatus = "complete" | "exhausted" | "continue";

export function flightStatus(
  flightEntries: FlightlogEntry[],
  tasks: Record<string, ParsedTask>,
): FlightStatus {
  const all = Object.values(tasks);
  if (all.every((t) => t.status === "done")) return "complete";

  const repairs = repairsIn(flightEntries);
  const counts = repairCounts(flightEntries);
  // A synthetic ref has no Status to reset, so a halt on it would re-launch
  // into the same stop without bound.
  if (repairs.some((r) => r.task.startsWith("(") && r.verdict === "halt")) {
    return "exhausted";
  }
  if (counts.flight >= FLIGHT_REPAIR_CAP) return "exhausted";
  // A leak abort pushes no escalation of its own and its stopped tasks report
  // `infrastructure`, so only the run-end's flag keeps them from an infra-retry.
  const ends = flightEntries.flatMap((e, at) =>
    e.kind === "run-end" ? [at] : [],
  );
  const lastEnd = flightEntries[ends.at(-1) ?? -1] as RunEndEntry | undefined;
  if (lastEnd?.aborted) return "exhausted";
  if (lastEnd && ends.length >= 2 && lastEnd.completed.length === 0) {
    const round = flightEntries.slice(ends.at(-2)! + 1, ends.at(-1));
    if (repairCounts(round).flight === 0) return "exhausted";
  }

  const ready = new Set(findReady(tasks).map((r) => `${r.bucket}/${r.nn}`));
  const stopped = new Set(
    repairs
      .filter((r) => r.verdict === "refuse" || r.verdict === "halt")
      .map((r) => r.task),
  );
  const seen = new Set(
    flightEntries
      .filter((e) => e.kind === "escalation" || e.kind === "repair")
      .map((e) => e.task),
  );
  const repairable = Object.entries(tasks).some(([ref, task]) => {
    if (stopped.has(ref)) return false;
    if (ready.has(ref) || task.status === "in-progress") return true;
    return (
      task.status === "blocked" &&
      seen.has(ref) &&
      (counts.byTask[ref] ?? 0) < TASK_REPAIR_CAP
    );
  });
  return repairable ? "continue" : "exhausted";
}

export function admitRepair(
  flightEntries: FlightlogEntry[],
  task: string,
  verdict: RepairVerdict,
): { ok: true } | { ok: false; error: string } {
  const counts = repairCounts(flightEntries);
  if (COUNTED.has(verdict)) {
    if (counts.flight >= FLIGHT_REPAIR_CAP) {
      return {
        ok: false,
        error: `flight repair budget spent (${counts.flight}/${FLIGHT_REPAIR_CAP}); record halt instead`,
      };
    }
    const used = counts.byTask[task] ?? 0;
    if (used >= TASK_REPAIR_CAP) {
      return {
        ok: false,
        error: `${task} repair budget spent (${used}/${TASK_REPAIR_CAP}); record refuse instead`,
      };
    }
  }
  const prior = repairsIn(flightEntries).filter((r) => r.task === task);
  if (verdict === "not-plan" && prior.some((r) => r.verdict === "not-plan")) {
    return {
      ok: false,
      error: `${task} already had a not-plan re-fly; record refuse instead`,
    };
  }
  if (
    verdict === "infra-retry" &&
    prior.some((r) => r.verdict === "infra-retry")
  ) {
    return {
      ok: false,
      error: `${task} already had an infra-retry; record halt instead`,
    };
  }
  return { ok: true };
}

export type GuardInput = {
  verdict: "fix" | "defer";
  isLeg: boolean;
  flightGoalHash: string;
  planMd: string;
  before: Record<string, string>;
  after: Record<string, string>;
  doneRefs: string[];
  justified: { task: string; before: string }[];
  kept: string[];
  devReportedDefect: string[];
  workedRefs: string[];
  deferred: { task: string; criterion: string }[];
};

const PREAMBLE = "";

function splitSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading = PREAMBLE;
  let buffer: string[] = [];
  const flush = () => sections.set(heading, buffer.join("\n"));
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
      buffer = [];
      continue;
    }
    if (heading === PREAMBLE && matchStatusLine(line.replace(/^>\s?/, ""))) {
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

const GATE_ITEM = /^\s*[-*]\s+\[[ xX]\]\s*(.*)$/;
const TICKED_ITEM = /^\s*[-*]\s+\[[xX]\]/;

const itemText = (line: string): string =>
  (GATE_ITEM.exec(line)?.[1] ?? line).trim();

function gateLines(sections: Map<string, string>, heading: string): string[] {
  return (sections.get(heading) ?? "")
    .split("\n")
    .filter((l) => GATE_ITEM.test(l));
}

const gateItems = (sections: Map<string, string>, heading: string): string[] =>
  gateLines(sections, heading).map(itemText);

const tickedItems = (
  sections: Map<string, string>,
  heading: string,
): string[] =>
  gateLines(sections, heading)
    .filter((l) => TICKED_ITEM.test(l))
    .map(itemText);

function statusOf(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) return null;
    const match = matchStatusLine(line.replace(/^>\s?/, ""));
    if (match) return match.raw.trim().toLowerCase();
  }
  return null;
}

function withoutEach(items: string[], remove: string[]): string[] {
  const left = [...items];
  for (const item of remove) {
    const at = left.indexOf(item);
    if (at !== -1) left.splice(at, 1);
  }
  return left;
}

export function guardRepair(
  input: GuardInput,
):
  | { ok: true; reentry: Record<string, "dev" | "verify"> }
  | { ok: false; violations: string[] } {
  const violations: string[] = [];
  if (goalHash(input.planMd) !== input.flightGoalHash) {
    violations.push("PLAN.md goal section changed since the flight started");
  }
  if (input.verdict === "defer" && !input.isLeg) {
    violations.push("defer is only valid inside a waypoints leg");
  }

  const reentry: Record<string, "dev" | "verify"> = {};
  const refs = [
    ...new Set([...Object.keys(input.before), ...Object.keys(input.after)]),
  ].sort();
  for (const ref of refs) {
    const beforeText = input.before[ref];
    const afterText = input.after[ref];
    if (afterText === undefined) {
      violations.push(`deleted task ${ref}`);
      continue;
    }
    if (beforeText === undefined) {
      violations.push(`created task ${ref}`);
      continue;
    }
    if (beforeText === afterText) continue;
    if (input.doneRefs.includes(ref)) {
      violations.push(`${ref} is done and must not be edited`);
    }

    if (statusOf(afterText) === "done" && statusOf(beforeText) !== "done") {
      violations.push(`${ref} set Status to done`);
    }

    const before = splitSections(beforeText);
    const after = splitSections(afterText);
    const justified = input.justified
      .filter((j) => j.task === ref)
      .map((j) => itemText(j.before));
    const deferred = input.deferred
      .filter((d) => d.task === ref)
      .map((d) => itemText(d.criterion));

    for (const heading of GATE_SECTIONS) {
      const old = gateItems(before, heading);
      const now = gateItems(after, heading);
      const tagged = (items: string[]) =>
        items.filter((i) => i.includes("(human)")).length;
      if (tagged(now) > tagged(old)) {
        violations.push(`${ref} ${heading}: added a (human) tag`);
      }
      for (const ticked of withoutEach(
        tickedItems(after, heading),
        tickedItems(before, heading),
      )) {
        violations.push(`${ref} ${heading}: ticked a box: ${ticked}`);
      }
      for (const gone of withoutEach(old, now)) {
        if (!justified.includes(gone)) {
          violations.push(
            `${ref} ${heading}: removed or reworded without justification: ${gone}`,
          );
        }
        if (
          heading === "Acceptance criteria" &&
          input.verdict === "defer" &&
          !deferred.includes(gone)
        ) {
          violations.push(
            `${ref} Acceptance criteria: removed under defer but not in the defer list: ${gone}`,
          );
        }
      }
      if (
        heading === "Acceptance criteria" &&
        input.verdict !== "defer" &&
        now.length < old.length
      ) {
        violations.push(
          `${ref} Acceptance criteria: item count dropped from ${old.length} to ${now.length}`,
        );
      }
    }

    for (const what of rubricWeakenings(
      parseRubric(beforeText),
      parseRubric(afterText),
    )) {
      violations.push(`weakened rubric ${ref}: ${what}`);
    }

    const differing = [...new Set([...before.keys(), ...after.keys()])].filter(
      (heading) => before.get(heading) !== after.get(heading),
    );
    const gateOnly = differing.every((h) => VERIFY_SECTIONS.has(h));
    reentry[ref] =
      gateOnly &&
      input.kept.includes(ref) &&
      input.workedRefs.includes(ref) &&
      !input.devReportedDefect.includes(ref)
        ? "verify"
        : "dev";
  }

  return violations.length > 0
    ? { ok: false, violations }
    : { ok: true, reentry };
}

function rubricWeakenings(old: Rubric | null, now: Rubric | null): string[] {
  if (old === null) return [];
  if (now === null) return ["rubric removed or unparseable"];
  const found: string[] = [];
  if (now.passThreshold < old.passThreshold) {
    found.push(
      `threshold lowered from ${old.passThreshold} to ${now.passThreshold}`,
    );
  }
  if (now.passOp !== old.passOp) {
    found.push(`pass operator changed from ${old.passOp} to ${now.passOp}`);
  }
  for (const veto of old.hardFails) {
    const kept = now.hardFails.some(
      (v) =>
        v.dimension === veto.dimension &&
        v.op === veto.op &&
        v.value === veto.value,
    );
    if (!kept) {
      found.push(`removed veto ${veto.dimension} ${veto.op} ${veto.value}`);
    }
  }
  for (const veto of withoutEach(old.unknownVetoes, now.unknownVetoes)) {
    found.push(`removed veto ${veto}`);
  }
  const weights = new Map(now.dimensions.map((d) => [d.name, d.weight]));
  const oldNames = new Set(old.dimensions.map((d) => d.name));
  for (const d of old.dimensions) {
    const weight = weights.get(d.name);
    if (weight === undefined) {
      found.push(`removed dimension ${d.name}`);
    } else if (weight !== d.weight) {
      found.push(`weight of ${d.name} changed from ${d.weight} to ${weight}`);
    }
  }
  for (const d of now.dimensions) {
    if (!oldNames.has(d.name)) found.push(`added dimension ${d.name}`);
  }
  return found;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function errorLine(e: EscalationEntry | ScoreEntry | RunEndEntry): string {
  if (e.kind === "escalation") {
    return `- ${e.ts} · ${e.task} · escalation — ${e.class}: ${oneLine(e.reason)}`;
  }
  if (e.kind === "score") {
    return `- ${e.ts} · ${e.task} · attempt ${e.attempt} · judge — score ${e.weighted.toFixed(2)} ${e.passOp} ${e.threshold} → FAIL`;
  }
  const drained = e.drained.length ? ` · drained: ${e.drained.join(", ")}` : "";
  return `- ${e.ts} · (flight) · run aborted${drained}`;
}

function stillParked(
  entries: FlightlogEntry[],
  tasks: Record<string, ParsedTask>,
): string[] {
  return Object.keys(tasks)
    .filter((ref) => tasks[ref].status !== "done")
    .sort()
    .map((ref) => {
      const repair = entries.findLast(
        (e): e is RepairEntry => e.kind === "repair" && e.task === ref,
      );
      const escalation = entries.findLast(
        (e): e is EscalationEntry => e.kind === "escalation" && e.task === ref,
      );
      const reason =
        repair?.reason ??
        escalation?.reason ??
        "no escalation or repair recorded";
      return `- ${ref}: ${oneLine(reason)}`;
    });
}

export function renderFlightReport(
  flightEntries: FlightlogEntry[],
  opts: {
    slug: string;
    status: FlightStatus;
    deferredMd: string | null;
    tasks: Record<string, ParsedTask>;
  },
): string {
  const entries = [...flightEntries].sort((a, b) => a.ts.localeCompare(b.ts));
  const used = repairCounts(entries).flight;
  const out: string[] = [
    `# Flight report — ${opts.slug}`,
    "",
    `Outcome: **${opts.status}** · repairs used ${used}/${FLIGHT_REPAIR_CAP}`,
    "",
    GUARD_LIMIT,
    "",
  ];
  const none = (lines: string[]) => (lines.length ? lines : ["None."]);

  if (opts.deferredMd !== null) {
    out.push("## Deferred criteria", "", opts.deferredMd.trim(), "");
  }

  const errors = entries
    .filter(
      (e): e is EscalationEntry | ScoreEntry | RunEndEntry =>
        e.kind === "escalation" ||
        (e.kind === "score" && !e.passed) ||
        (e.kind === "run-end" && e.aborted),
    )
    .map(errorLine);
  out.push("## Error events", "", ...none(errors), "");

  out.push("## Repairs", "");
  const repairs = repairsIn(entries);
  if (repairs.length === 0) out.push("None.", "");
  for (const r of repairs) {
    out.push(`### ${r.task} — ${r.verdict}`, "");
    if (r.pattern) out.push(`- Pattern: ${oneLine(r.pattern)}`);
    out.push(`- Reason: ${oneLine(r.reason)}`, "");
    if (r.diff) out.push("```diff", r.diff.trimEnd(), "```", "");
  }

  out.push(
    "## Still parked",
    "",
    ...none(stillParked(entries, opts.tasks)),
    "",
  );

  const latestByTask = new Map<string, string[]>();
  for (const e of entries) {
    if (e.kind !== "run-end") continue;
    for (const { task, criteria } of e.needsHuman ?? [])
      latestByTask.set(task, criteria);
  }
  const human = [...latestByTask].flatMap(([task, criteria]) =>
    criteria.map((c) => `- [ ] ${task}: ${oneLine(c)}`),
  );
  out.push("## Needs a person", "", ...none(human), "");

  const ungated = entries
    .filter(
      (e): e is NoteEntry =>
        e.kind === "note" && e.task === "(flight)" && e.role === "ungated",
    )
    .map((e) => `- ${e.ts} · ${oneLine(e.message)}`);
  if (ungated.length > 0) out.push("## Ungated trees", "", ...ungated, "");
  return out.join("\n");
}
