import {
  addCounts,
  emptyCounts,
  type AgentUsage,
  type TokenCounts,
  type UsageRollup,
} from "./usage-types";
import { fleetIdentity, type FleetRow } from "./fleet";

function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

const groupRowsByIdentity = (rows: FleetRow[]): Map<string, FleetRow[]> =>
  Map.groupBy(rows, (row) => row.identity);

// The two role vocabularies are already the same strings, so no translation
// layer sits between an agent's parsed role and a row's role.
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
 * Pair one identity group's rows to its agents one-to-one by nearest start time.
 * Greedy nearest-neighbour, not a global optimum: agents in one fan-out start seconds
 * apart, so greedy and optimal agree in every observed case.
 */
function pairGroup(
  rows: FleetRow[],
  agents: AgentUsage[],
): Map<number, number> {
  const pairing = new Map<number, number>();
  const pairedRows = new Set<number>();
  const pairedAgents = new Set<number>();

  const agentMsByIndex = agents.map((agent) => toEpochMs(agent.startedAt));
  const candidates: Candidate[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const rowMs = toEpochMs(rows[rowIndex]!.startedAt);
    if (rowMs === null) continue;
    for (let agentIndex = 0; agentIndex < agents.length; agentIndex++) {
      const agentMs = agentMsByIndex[agentIndex]!;
      if (agentMs === null) continue;
      candidates.push({
        rowIndex,
        agentIndex,
        distance: Math.abs(rowMs - agentMs),
      });
    }
  }

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
  const byTask: Record<string, TokenCounts> = Object.create(null);
  const codexByTask: Record<string, TokenCounts> = Object.create(null);
  const unattributed = emptyCounts();
  const totals = emptyCounts();
  const codexTotals = emptyCounts();
  let codexRunCount = 0;

  for (const agent of agents) {
    addCounts(totals, agent.counts);
    if (agent.codexCounts) {
      addCounts(codexTotals, agent.codexCounts);
      codexRunCount++;
    }
    if (agent.task === null) {
      addCounts(unattributed, agent.counts);
      continue;
    }
    let taskCounts = byTask[agent.task];
    if (taskCounts === undefined) {
      taskCounts = emptyCounts();
      byTask[agent.task] = taskCounts;
    }
    addCounts(taskCounts, agent.counts);

    if (agent.codexCounts) {
      let taskCodex = codexByTask[agent.task];
      if (taskCodex === undefined) {
        taskCodex = emptyCounts();
        codexByTask[agent.task] = taskCodex;
      }
      addCounts(taskCodex, agent.codexCounts);
    }
  }

  return {
    byTask,
    unattributed,
    totals,
    agentCount: agents.length,
    codexByTask,
    codexTotals,
    codexRunCount,
  };
}

export function attributeUsage(
  rows: FleetRow[],
  agents: AgentUsage[],
): { rows: FleetRow[]; rollup: UsageRollup } {
  const rowGroups = groupRowsByIdentity(rows);
  const agentGroups = groupAgentsByIdentity(agents);

  const usageByRow = new Map<FleetRow, TokenCounts>();
  const codexByRow = new Map<FleetRow, TokenCounts>();
  const modelsByRow = new Map<FleetRow, string[]>();
  const codexModelsByRow = new Map<FleetRow, string[]>();

  for (const [identity, groupRows] of rowGroups) {
    const groupAgents = agentGroups.get(identity);
    if (!groupAgents) continue;
    const pairing = pairGroup(groupRows, groupAgents);
    for (const [rowIndex, agentIndex] of pairing) {
      const row = groupRows[rowIndex]!;
      const agent = groupAgents[agentIndex]!;
      usageByRow.set(row, agent.counts);
      if (agent.codexCounts) codexByRow.set(row, agent.codexCounts);
      if (agent.models.length > 0) modelsByRow.set(row, agent.models);
      if (agent.codexModels && agent.codexModels.length > 0) {
        codexModelsByRow.set(row, agent.codexModels);
      }
    }
  }

  const newRows = rows.map((row) => {
    const usage = usageByRow.get(row);
    const codexUsage = codexByRow.get(row);
    const models = modelsByRow.get(row);
    const codexModels = codexModelsByRow.get(row);
    return {
      ...row,
      ...(usage === undefined ? {} : { usage }),
      ...(codexUsage === undefined ? {} : { codexUsage }),
      ...(models === undefined ? {} : { models }),
      ...(codexModels === undefined ? {} : { codexModels }),
    };
  });

  return { rows: newRows, rollup: buildRollup(agents) };
}
