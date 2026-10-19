/**
 * The four counters Claude Code writes on every billed assistant turn. All four are
 * kept though only `input` and `output` render — they arrive in one object anyway.
 */
export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export function emptyCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addCounts(into: TokenCounts, from: TokenCounts): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
}

export function replaceCounts(
  into: TokenCounts,
  previous: TokenCounts,
  next: TokenCounts,
): void {
  into.input += next.input - previous.input;
  into.output += next.output - previous.output;
  into.cacheRead += next.cacheRead - previous.cacheRead;
  into.cacheWrite += next.cacheWrite - previous.cacheWrite;
}

export type AgentUsage = {
  file: string;
  task: string | null;
  role: string | null;
  attempt: number | undefined;
  startedAt: string | null;
  lastAt: string | null;
  /**
   * Relay scratch directory names this transcript mentions, e.g.
   * `20260829-164034-617-28486-7d4298ab`. When the agent drove codex through a relay
   * live pane, the codex rollout names the same directory — an exact join key that
   * beats any time-window guess. Empty for an agent that drove no external CLI.
   */
  relayDirs: string[];
  /**
   * Whether this transcript shows the agent driving an external CLI — a relay scratch
   * path, or a call to one of the `<engine>-run.ts` wrappers. Only such an agent may
   * claim a codex run by time window: a judge or a verifier running while the user has
   * their own codex window open in the same repo must never absorb that window's spend.
   */
  externalDriver: boolean;
  models: string[];
  counts: TokenCounts;
  /**
   * Spend of the codex CLI run this agent drove, kept OUT of `counts` on purpose.
   * A dev-codex row is a Claude driver plus an expensive external model, and
   * one merged figure would hide which side burned what. Undefined for an agent
   * that drove no external CLI — never a zeroed object, which would read as a
   * measured "codex did nothing".
   */
  codexCounts?: TokenCounts;
  /**
   * Every codex model that produced a run this agent drove, in first-seen order,
   * deduplicated. Absent (never an empty array) for an agent that drove no external
   * CLI — matching the absent-not-empty rule `codexCounts` already follows.
   */
  codexModels?: string[];
};

export type UsageRollup = {
  byTask: Record<string, TokenCounts>;
  unattributed: TokenCounts;
  totals: TokenCounts;
  agentCount: number;
  codexByTask: Record<string, TokenCounts>;
  codexTotals: TokenCounts;
  codexRunCount: number;
};
