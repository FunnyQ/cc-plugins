import { createHash } from "node:crypto";
import { findReady } from "../next-ready";
import type {
  EscalationEntry,
  FlightEntry,
  FlightlogEntry,
  RepairEntry,
  RepairVerdict,
  RunEndEntry,
  ScoreEntry,
} from "./flightlog";
import { GATE_SECTIONS, matchStatusLine, type ParsedTask } from "./parse-task";

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
  if (repairs.some((r) => r.task === "(flight)" && r.verdict === "halt")) {
    return "exhausted";
  }
  if (counts.flight >= FLIGHT_REPAIR_CAP) return "exhausted";

  const ready = new Set(findReady(tasks).map((r) => `${r.bucket}/${r.nn}`));
  const stopped = new Set(
    repairs
      .filter((r) => r.verdict === "refuse" || r.verdict === "halt")
      .map((r) => r.task),
  );
  const repairable = Object.entries(tasks).some(([ref, task]) => {
    if (ready.has(ref) || task.status === "in-progress") return true;
    return (
      task.status === "blocked" &&
      !stopped.has(ref) &&
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

const itemText = (line: string): string =>
  (GATE_ITEM.exec(line)?.[1] ?? line).trim();

function gateItems(sections: Map<string, string>, heading: string): string[] {
  return (sections.get(heading) ?? "")
    .split("\n")
    .filter((l) => GATE_ITEM.test(l))
    .map(itemText);
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

    const before = splitSections(beforeText);
    const after = splitSections(afterText);
    const justified = input.justified
      .filter((j) => j.task === ref)
      .map((j) => itemText(j.before));

    for (const heading of GATE_SECTIONS) {
      const old = gateItems(before, heading);
      const now = gateItems(after, heading);
      const tagged = (items: string[]) =>
        items.filter((i) => i.includes("(human)")).length;
      if (tagged(now) > tagged(old)) {
        violations.push(`${ref} ${heading}: added a (human) tag`);
      }
      for (const gone of withoutEach(old, now)) {
        if (!justified.includes(gone)) {
          violations.push(
            `${ref} ${heading}: removed or reworded without justification: ${gone}`,
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

  const lastEnd = entries.findLast(
    (e): e is RunEndEntry => e.kind === "run-end",
  );
  const human = (lastEnd?.needsHuman ?? []).flatMap(({ task, criteria }) =>
    criteria.map((c) => `- [ ] ${task}: ${oneLine(c)}`),
  );
  out.push("## Needs a person", "", ...none(human), "");
  return out.join("\n");
}
