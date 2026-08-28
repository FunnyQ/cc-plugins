import type { AgentUsage, TokenCounts, UsageRollup } from "./usage-types";
import type { FleetRow } from "./fleet";
import { fleetIdentity } from "./fleet";
import { emptyCounts } from "./usage-source";

/** Add `from` into `into`, in place. `into` is always a fresh accumulator. */
export function addCounts(into: TokenCounts, from: TokenCounts): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
}

/** Epoch ms, or `null` for a missing/unparseable timestamp — never `NaN`, never `0`. A
 * zero would read as 1970 and win every comparison it entered. */
function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// A FleetRow carries no identity string of its own, so rebuild it the same way the
// fleet module does. `row.ref` falls back to the logged task even for the review-lens
// label shape, which parses a lens instead of a ref.
const groupRowsByIdentity = (rows: FleetRow[]): Map<string, FleetRow[]> =>
  Map.groupBy(rows, (row) =>
    fleetIdentity(row.ref ?? "", row.role, row.attempt),
  );

// A null task or role belongs to no group — it can never be paired, but it still
// counts toward the rollup below. The two role vocabularies are the same strings
// already (see ../_context/data-model.md), so no translation layer sits between an
// agent's parsed role and a row's role.
const groupAgentsByIdentity = (
  agents: AgentUsage[],
): Map<string, AgentUsage[]> =>
  Map.groupBy(
    agents.filter((agent) => agent.task !== null && agent.role !== null),
    (agent) => fleetIdentity(agent.task!, agent.role!, agent.attempt),
  );

type Candidate = {
  rowIndex: number;
  agentIndex: number;
  distance: number;
};

/**
 * Pair one identity group's rows to its agents one-to-one by nearest start
 * time. This is greedy nearest-neighbour, not a global optimum — a full
 * assignment solver would be a solver nobody asked for. Agents in one fan-out
 * start seconds apart, so the greedy and optimal assignments agree in every
 * observed case.
 */
function pairGroup(
  rows: FleetRow[],
  agents: AgentUsage[],
): Map<number, number> {
  const pairing = new Map<number, number>();
  const pairedRows = new Set<number>();
  const pairedAgents = new Set<number>();

  const candidates: Candidate[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const rowMs = toEpochMs(rows[rowIndex]!.startedAt);
    if (rowMs === null) continue;
    for (let agentIndex = 0; agentIndex < agents.length; agentIndex++) {
      const agentMs = toEpochMs(agents[agentIndex]!.startedAt);
      if (agentMs === null) continue;
      candidates.push({
        rowIndex,
        agentIndex,
        distance: Math.abs(rowMs - agentMs),
      });
    }
  }

  // Ascending by distance; ties break on the agent's file path, then the row's
  // key. The tie-break is what makes the function deterministic across calls.
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    const fileCompare = agents[a.agentIndex]!.file.localeCompare(
      agents[b.agentIndex]!.file,
    );
    if (fileCompare !== 0) return fileCompare;
    return rows[a.rowIndex]!.key.localeCompare(rows[b.rowIndex]!.key);
  });

  for (const candidate of candidates) {
    if (pairedRows.has(candidate.rowIndex)) continue;
    if (pairedAgents.has(candidate.agentIndex)) continue;
    pairing.set(candidate.rowIndex, candidate.agentIndex);
    pairedRows.add(candidate.rowIndex);
    pairedAgents.add(candidate.agentIndex);
  }

  // Every timestamped candidate has had its chance. Whatever remains — either
  // side missing a usable timestamp — pairs in stable order.
  const remainingRowIndexes = rows
    .map((_, index) => index)
    .filter((index) => !pairedRows.has(index))
    .sort((a, b) => rows[a]!.key.localeCompare(rows[b]!.key));
  const remainingAgentIndexes = agents
    .map((_, index) => index)
    .filter((index) => !pairedAgents.has(index))
    .sort((a, b) => agents[a]!.file.localeCompare(agents[b]!.file));

  const remainingCount = Math.min(
    remainingRowIndexes.length,
    remainingAgentIndexes.length,
  );
  for (let i = 0; i < remainingCount; i++) {
    pairing.set(remainingRowIndexes[i]!, remainingAgentIndexes[i]!);
  }

  return pairing;
}

function buildRollup(agents: AgentUsage[]): UsageRollup {
  // Prototype-free: task refs are parsed out of a transcript, so `__proto__` or
  // `constructor` can reach this lookup. On a plain `{}` they resolve to an
  // inherited value instead of `undefined`, and the accumulate below would then
  // write counts onto `Object.prototype` — NaN totals, a task silently missing
  // from the panel, and every other object in the process polluted.
  const byTask: Record<string, TokenCounts> = Object.create(null);
  const unattributed = emptyCounts();
  const totals = emptyCounts();

  for (const agent of agents) {
    addCounts(totals, agent.counts);
    if (agent.task === null) {
      addCounts(unattributed, agent.counts);
      continue;
    }
    // Counted whether or not this agent paired to a row — the task total must
    // not depend on whether the pairing found a home for it.
    let taskCounts = byTask[agent.task];
    if (taskCounts === undefined) {
      taskCounts = emptyCounts();
      byTask[agent.task] = taskCounts;
    }
    addCounts(taskCounts, agent.counts);
  }

  return { byTask, unattributed, totals, agentCount: agents.length };
}

/**
 * Attach per-agent usage to fleet rows and roll the whole set up.
 * Returns new row objects; never mutates the input.
 */
export function attributeUsage(
  rows: FleetRow[],
  agents: AgentUsage[],
): { rows: FleetRow[]; rollup: UsageRollup } {
  const rowGroups = groupRowsByIdentity(rows);
  const agentGroups = groupAgentsByIdentity(agents);

  // Never a zeroed TokenCounts on an unpaired row: the rendering layer relies
  // on `undefined` meaning "no data" and `0` meaning "measured zero" — an
  // external-engine agent must never read as a row that burned nothing.
  const usageByRow = new Map<FleetRow, TokenCounts>();

  for (const [identity, groupRows] of rowGroups) {
    const groupAgents = agentGroups.get(identity);
    if (!groupAgents) continue;
    const pairing = pairGroup(groupRows, groupAgents);
    for (const [rowIndex, agentIndex] of pairing) {
      usageByRow.set(groupRows[rowIndex]!, groupAgents[agentIndex]!.counts);
    }
  }

  const newRows = rows.map((row) => {
    const usage = usageByRow.get(row);
    return usage === undefined ? { ...row } : { ...row, usage };
  });

  return { rows: newRows, rollup: buildRollup(agents) };
}
