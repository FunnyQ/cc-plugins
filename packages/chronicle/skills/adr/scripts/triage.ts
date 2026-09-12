#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { logRoot, STALE_MS } from "../../../shared/scripts/cockpit-trail";
import { TEMP_ROOT } from "../../../shared/scripts/temp-payload";
import { buildIndex, type AdrMeta } from "./adr-index";
import {
  everySessionMissing,
  mtimeOf,
  planArchive,
  type Assignment,
  type SourceBucket,
} from "./archive-plan";
import {
  collectContext,
  type AdrContext,
  type SessionFile,
} from "./collect-adr-context";
import type {
  Disposition,
  Gate1Candidate,
  Gate1Conflict,
  Gate1Payload,
} from "./gate-page";

export type Cluster = {
  clusterId: string;
  decision: string;
  entryIds: string[];
  sessionIds: string[];
  kinds: string[];
  files: string[];
  /** True when the cluster holds an entry pulled back from the watched bucket. */
  watched: boolean;
};

export type Batch = {
  batch: number;
  adrs: Pick<AdrMeta, "id" | "title" | "status">[];
  clusters: Cluster[];
};

export type RecordedCandidate = Gate1Candidate & {
  clusterId: string;
  sessionIds: string[];
};

export type BatchResult = {
  batch: number;
  candidates: RecordedCandidate[];
  conflicts: Gate1Conflict[];
};

export type RunMeta = {
  trailRoot: string;
  adrDir: string;
  nextAdr: number;
  scan: {
    sessions: number;
    entries: number;
    clusters: number;
    tooFresh: number;
  };
  assignments: Assignment[];
  batchCount: number;
};

export type Override = {
  dispositions?: {
    entryIds?: string[];
    decision?: string;
    reason?: string;
    group?: string;
  }[];
};

const DISPOSITIONS: Disposition[] = ["promote", "watch", "skip"];
const MAX_JUDGES = 10;
const BATCH_SIZE = 8;

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `evidence` assigns no session because `promote` searches every bucket but must archive nothing. */
export function buildTriage(
  context: AdrContext,
  nowMs: number,
  opts: { evidence?: boolean } = {},
) {
  const evidence = opts.evidence === true;
  const stale = (session: SessionFile) => nowMs - session.mtimeMs >= STALE_MS;
  const inbox = context.sessions.filter(({ bucket }) => bucket === "inbox");
  const inboxIds = new Set(
    inbox.filter(stale).map(({ sessionId }) => sessionId),
  );
  const inboxDecisions = new Set(
    context.skeletons
      .filter(({ sessionId }) => inboxIds.has(sessionId))
      .map(({ decision }) => decision),
  );
  // Waking on an exact match mirrors the clustering: a looser wake would pull in a
  // watched session whose entries join no fresh cluster and are re-judged for nothing.
  const woken = new Set(
    context.sessions
      .filter(
        (session) =>
          session.bucket === "watch" &&
          stale(session) &&
          context.skeletons.some(
            (entry) =>
              entry.sessionId === session.sessionId &&
              inboxDecisions.has(entry.decision),
          ),
      )
      .map(({ sessionId }) => sessionId),
  );
  const done = new Set(
    context.sessions
      .filter(({ bucket }) => bucket === "done")
      .map(({ sessionId }) => sessionId),
  );
  const watchIds = new Set(
    context.sessions
      .filter(({ bucket }) => bucket === "watch")
      .map(({ sessionId }) => sessionId),
  );

  const byDecision = new Map<string, Cluster>();
  let entries = 0;
  for (const entry of context.skeletons) {
    const { sessionId } = entry;
    if (
      !evidence &&
      !inboxIds.has(sessionId) &&
      !woken.has(sessionId) &&
      !done.has(sessionId)
    ) {
      continue;
    }
    entries += 1;
    let cluster = byDecision.get(entry.decision);
    if (!cluster) {
      cluster = {
        clusterId: `c${byDecision.size + 1}`,
        decision: entry.decision,
        entryIds: [],
        sessionIds: [],
        kinds: [],
        files: [],
        watched: false,
      };
      byDecision.set(entry.decision, cluster);
    }
    cluster.entryIds.push(entry.id);
    pushUnique(cluster.sessionIds, sessionId);
    if (entry.kind) pushUnique(cluster.kinds, entry.kind);
    for (const file of entry.files) pushUnique(cluster.files, file);
    if (woken.has(sessionId) || (evidence && watchIds.has(sessionId))) {
      cluster.watched = true;
    }
  }

  const assignments: Assignment[] = (evidence ? [] : context.sessions)
    .filter(
      ({ bucket, sessionId }) =>
        (bucket === "inbox" && inboxIds.has(sessionId)) ||
        (bucket === "watch" && woken.has(sessionId)),
    )
    .map(({ sessionId, bucket }) => ({
      sessionId,
      target: "done",
      from: bucket as SourceBucket,
    }));

  return {
    clusters: [...byDecision.values()],
    assignments,
    entries,
    sessions: evidence
      ? context.sessions.length
      : inboxIds.size + woken.size + done.size,
    tooFresh: evidence ? 0 : inbox.length - inboxIds.size,
  };
}

/** At most MAX_JUDGES batches, each as close to BATCH_SIZE as that cap allows. */
export function planBatches<T>(items: T[]): T[][] {
  if (items.length === 0) return [];
  const count = Math.min(MAX_JUDGES, Math.ceil(items.length / BATCH_SIZE));
  const size = Math.ceil(items.length / count);
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/** Pure. Checks one judge's result against its batch; `result` is null whenever `errors` is not empty. */
export function validateJudgment(
  batch: Batch,
  input: unknown,
): { result: BatchResult | null; errors: string[] } {
  if (!isObject(input) || !Array.isArray(input.candidates)) {
    return {
      result: null,
      errors: ['Expected {"candidates": [...], "conflicts": [...]}.'],
    };
  }

  const errors: string[] = [];
  const clusters = new Map(
    batch.clusters.map((cluster) => [cluster.clusterId, cluster]),
  );
  const adrIds = new Set(batch.adrs.map(({ id }) => id));
  const recorded = new Map<string, RecordedCandidate>();

  for (const raw of input.candidates) {
    if (!isObject(raw)) {
      errors.push("Every candidate must be an object.");
      continue;
    }
    const clusterId = String(raw.clusterId ?? "");
    const cluster = clusters.get(clusterId);
    if (!cluster) {
      errors.push(`Unknown clusterId "${clusterId}": it is not in this batch.`);
      continue;
    }
    if (recorded.has(clusterId)) {
      errors.push(
        `Duplicate candidate for ${clusterId}: give exactly one per cluster.`,
      );
      continue;
    }
    if (!DISPOSITIONS.includes(raw.disposition as Disposition)) {
      errors.push(
        `${clusterId}: disposition must be promote, watch, or skip, not "${String(raw.disposition)}".`,
      );
    }
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      errors.push(`${clusterId}: title is empty.`);
    }
    if (typeof raw.reason !== "string" || raw.reason.trim() === "") {
      errors.push(`${clusterId}: reason is empty.`);
    }
    const matchesAdr = raw.matchesAdr == null ? null : String(raw.matchesAdr);
    if (matchesAdr !== null && !adrIds.has(matchesAdr)) {
      errors.push(
        `${clusterId}: matchesAdr "${matchesAdr}" is not an existing record.`,
      );
    }
    recorded.set(clusterId, {
      clusterId,
      entryIds: cluster.entryIds,
      sessionIds: cluster.sessionIds,
      title: String(raw.title),
      reason: String(raw.reason),
      disposition: raw.disposition as Disposition,
      matchesAdr,
    });
  }
  for (const clusterId of clusters.keys()) {
    if (!recorded.has(clusterId))
      errors.push(`Missing candidate for ${clusterId}.`);
  }

  const clusterOfEntry = new Map<string, string>();
  for (const cluster of batch.clusters) {
    for (const id of cluster.entryIds)
      clusterOfEntry.set(id, cluster.clusterId);
  }
  const conflicts: Gate1Conflict[] = [];
  const rawConflicts = input.conflicts ?? [];
  if (!Array.isArray(rawConflicts)) {
    errors.push("conflicts must be an array.");
  } else {
    for (const raw of rawConflicts) {
      if (
        !isObject(raw) ||
        typeof raw.summary !== "string" ||
        raw.summary.trim() === "" ||
        !Array.isArray(raw.entryIds) ||
        raw.entryIds.length === 0
      ) {
        errors.push(
          "Every conflict needs a summary and at least one entry id.",
        );
        continue;
      }
      const entryIds = raw.entryIds.map(String);
      for (const id of entryIds) {
        const clusterId = clusterOfEntry.get(id);
        if (!clusterId) {
          errors.push(`Conflict entry "${id}" is not in this batch.`);
        } else if (recorded.get(clusterId)?.disposition !== "watch") {
          errors.push(
            `${clusterId} has a conflict, so its disposition must be watch: a conflict comes before every skip or promote.`,
          );
        }
      }
      conflicts.push({ entryIds, note: raw.summary });
    }
  }

  if (errors.length > 0) return { result: null, errors };
  return {
    result: {
      batch: batch.batch,
      candidates: batch.clusters.map(
        ({ clusterId }) => recorded.get(clusterId)!,
      ),
      conflicts,
    },
    errors: [],
  };
}

/** The result a batch gets when its judge failed twice: every cluster at `watch`, never a silent `skip`. */
export function fallbackResult(batch: Batch): BatchResult {
  return {
    batch: batch.batch,
    candidates: batch.clusters.map((cluster) => ({
      clusterId: cluster.clusterId,
      entryIds: cluster.entryIds,
      sessionIds: cluster.sessionIds,
      title: cluster.decision,
      reason: `The judge for batch ${batch.batch} failed twice; review this cluster by hand.`,
      disposition: "watch",
      matchesAdr: null,
    })),
    conflicts: [],
  };
}

/** Pure. `results[i]` is batch `batches[i]`'s recorded result, or null when its judge never recorded one. */
export function mergeTriage(
  run: RunMeta,
  batches: Batch[],
  results: (BatchResult | null)[],
  overrides: Override[],
): {
  payload: Gate1Payload;
  assignments: Assignment[];
  ledger: string;
  errors: string[];
} {
  const errors: string[] = [];
  const rows: (RecordedCandidate & { batch: number })[] = [];
  const conflicts: Gate1Conflict[] = [];

  batches.forEach((batch, index) => {
    const result = results[index];
    if (result) {
      rows.push(
        ...result.candidates.map((candidate) => ({
          ...candidate,
          batch: batch.batch,
        })),
      );
      conflicts.push(...result.conflicts);
    } else {
      errors.push(`No judge result for batch ${batch.batch}.`);
    }
  });

  const keyOf = (entryIds: string[]) => [...entryIds].sort().join(" ");
  const rowByKey = new Map(rows.map((row) => [keyOf(row.entryIds), row]));
  for (const file of overrides) {
    for (const override of file.dispositions ?? []) {
      const named = JSON.stringify(override.entryIds ?? []);
      const row = rowByKey.get(keyOf(override.entryIds ?? []));
      if (!row) {
        errors.push(`Override names no candidate: ${named}.`);
        continue;
      }
      if (!DISPOSITIONS.includes(override.decision as Disposition)) {
        errors.push(
          `Override for ${named} has decision "${String(override.decision)}", not promote, watch, or skip.`,
        );
        continue;
      }
      row.disposition = override.decision as Disposition;
      if (override.reason) row.reason = override.reason;
    }
  }

  const watchedSessions = new Set(
    rows
      .filter(({ disposition }) => disposition === "watch")
      .flatMap(({ sessionIds }) => sessionIds),
  );
  const assignments: Assignment[] = run.assignments.map((assignment) => ({
    ...assignment,
    target: watchedSessions.has(assignment.sessionId) ? "watch" : "done",
  }));

  const ledger = DISPOSITIONS.flatMap((disposition) =>
    rows
      .filter((row) => row.disposition === disposition)
      .map(
        (row) =>
          `- [${disposition}] batch ${row.batch} ${row.clusterId} — ${row.title} — ${row.reason}${row.matchesAdr ? ` (matches ${row.matchesAdr})` : ""}`,
      ),
  ).join("\n");

  return {
    payload: {
      gate: 1,
      nextAdr: run.nextAdr,
      candidates: rows.map(
        ({ entryIds, title, reason, disposition, matchesAdr }) => ({
          entryIds,
          title,
          reason,
          disposition,
          matchesAdr,
        }),
      ),
      conflicts,
      scan: { ...run.scan, conflicts: conflicts.length },
    },
    assignments,
    ledger: `${ledger}\n`,
    errors,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  bun triage.ts prep [--evidence]",
    "  bun triage.ts record --batch <batch.json>   (judgment JSON on stdin)",
    "  bun triage.ts merge --run <runDir> [--overrides <file>]... [--missing-as-watch]",
  ].join("\n");
}

/** Reads `--name <value>` pairs and bare switches; anything outside `allowed` is a usage error. */
function parseFlags(
  argv: string[],
  allowed: { values: string[]; switches: string[] },
): { values: Map<string, string[]>; switches: Set<string> } {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (allowed.switches.includes(argument)) {
      switches.add(argument);
    } else if (
      allowed.values.includes(argument) &&
      argv[index + 1] !== undefined
    ) {
      values.set(argument, [...(values.get(argument) ?? []), argv[index + 1]!]);
      index += 1;
    } else {
      throw new Error(usage());
    }
  }
  return { values, switches };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function batchPath(runDir: string, batch: number): string {
  return join(runDir, `batch-${String(batch).padStart(2, "0")}.json`);
}

function resultPath(path: string): string {
  return path.replace(/\.json$/, ".result.json");
}

function countDispositions(candidates: { disposition: Disposition }[]) {
  const counts = { promote: 0, watch: 0, skip: 0 };
  for (const { disposition } of candidates) counts[disposition] += 1;
  return counts;
}

async function prep(argv: string[]): Promise<void> {
  const { switches } = parseFlags(argv, {
    values: [],
    switches: ["--evidence"],
  });
  const evidence = switches.has("--evidence");
  const context = await collectContext(process.cwd(), {
    includeDone: evidence,
  });
  if (!context.hasTrail) {
    console.log(JSON.stringify({ hasTrail: false }));
    return;
  }

  const index = await buildIndex(context.adrDir);
  const triage = buildTriage(context, Date.now(), { evidence });
  const runDir = join(
    TEMP_ROOT,
    "adr",
    `${basename(context.trailRoot)}-${Date.now()}-${process.pid}`,
  );
  mkdirSync(runDir, { recursive: true });

  const adrs = index.adrs.map(({ id, title, status }) => ({
    id,
    title,
    status,
  }));
  const batches = planBatches(triage.clusters);
  const batchFiles = batches.map((clusters, position) => {
    const path = batchPath(runDir, position + 1);
    writeJson(path, { batch: position + 1, adrs, clusters } satisfies Batch);
    return path;
  });
  const scan = {
    sessions: triage.sessions,
    entries: triage.entries,
    clusters: triage.clusters.length,
    tooFresh: triage.tooFresh,
  };
  writeJson(join(runDir, "run.json"), {
    trailRoot: context.trailRoot,
    adrDir: context.adrDir,
    nextAdr: index.nextNumber,
    scan,
    assignments: triage.assignments,
    batchCount: batches.length,
  } satisfies RunMeta);

  console.log(
    JSON.stringify({
      hasTrail: true,
      runDir,
      nextAdr: index.nextNumber,
      ...scan,
      batches: batchFiles,
    }),
  );
}

async function record(argv: string[]): Promise<void> {
  const { values } = parseFlags(argv, { values: ["--batch"], switches: [] });
  const path = values.get("--batch")?.[0];
  if (!path) throw new Error(usage());
  const output = resultPath(path);
  if (existsSync(output)) {
    throw new Error(
      `Batch already recorded at ${output}. The first result stands; stop.`,
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch (error) {
    throw new Error(
      `stdin is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { result, errors } = validateJudgment(readJson<Batch>(path), input);
  if (!result) throw new Error(errors.join("\n"));

  // `wx` fails if a sibling retry wrote the file after the check above, so the first result still wins.
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(
    JSON.stringify({
      resultPath: output,
      ...countDispositions(result.candidates),
      conflicts: result.conflicts.length,
    }),
  );
}

async function merge(argv: string[]): Promise<void> {
  const { values, switches } = parseFlags(argv, {
    values: ["--run", "--overrides"],
    switches: ["--missing-as-watch"],
  });
  const runDir = values.get("--run")?.[0];
  if (!runDir) throw new Error(usage());

  const run = readJson<RunMeta>(join(runDir, "run.json"));
  const trailRoot = logRoot(process.cwd());
  if (trailRoot !== run.trailRoot) {
    throw new Error(
      `This run belongs to ${run.trailRoot}, but the cwd resolves to ${trailRoot}. Run merge from the cwd prep ran in.`,
    );
  }

  const batches: Batch[] = [];
  const results: (BatchResult | null)[] = [];
  for (let batch = 1; batch <= run.batchCount; batch += 1) {
    const path = batchPath(runDir, batch);
    const current = readJson<Batch>(path);
    batches.push(current);
    const output = resultPath(path);
    if (!existsSync(output) && switches.has("--missing-as-watch")) {
      // Written as the batch's result, so a later merge without the flag keeps it and a late judge is refused.
      writeFileSync(
        output,
        `${JSON.stringify(fallbackResult(current), null, 2)}\n`,
        { flag: "wx" },
      );
    }
    results.push(existsSync(output) ? readJson<BatchResult>(output) : null);
  }
  const merged = mergeTriage(
    run,
    batches,
    results,
    (values.get("--overrides") ?? []).map((path) => readJson<Override>(path)),
  );
  if (merged.errors.length > 0) throw new Error(merged.errors.join("\n"));

  const plan = planArchive(trailRoot, merged.assignments, {
    nowMs: Date.now(),
    mtimeOf,
    exists: existsSync,
  });
  if (everySessionMissing(plan)) {
    throw new Error(
      `Every session is missing from ${trailRoot}. Run merge from the cwd prep ran in.`,
    );
  }

  const gate1Path = join(runDir, "gate1.json");
  const planPath = join(runDir, "archive-plan.json");
  const ledgerPath = join(runDir, "ledger.md");
  writeJson(join(runDir, "assignments.json"), merged.assignments);
  writeJson(planPath, plan);
  writeJson(gate1Path, merged.payload);
  writeFileSync(ledgerPath, merged.ledger);

  console.log(
    JSON.stringify({
      gate1Path,
      planPath,
      ledgerPath,
      ...countDispositions(merged.payload.candidates),
      conflicts: merged.payload.conflicts?.length ?? 0,
      moves: plan.moves.length,
      refused: plan.refused.length,
    }),
  );
}

if (import.meta.main) {
  const [command, ...rest] = Bun.argv.slice(2);
  const commands: Record<string, (argv: string[]) => Promise<void>> = {
    prep,
    record,
    merge,
  };
  try {
    const run = command ? commands[command] : undefined;
    if (!run) throw new Error(usage());
    await run(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
