// No imports on purpose: `fleet.ts` will import `TokenCounts` from here, so this
// file must depend on nothing or that edge becomes a cycle. Do not "fix" this back in.

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

/** Add `from` into `into`, in place. `into` is always a fresh accumulator. */
export function addCounts(into: TokenCounts, from: TokenCounts): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
}

/** Swap `previous` for `next` inside the running total `into`, in place. */
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

/** One Workflow-spawned agent's whole run, distilled from its transcript. */
export type AgentUsage = {
  /** Absolute path of the transcript. The stable identity across passes. */
  file: string;
  /** Task ref from the opening prompt, e.g. "ui/03" or "scout". Null when unparseable. */
  task: string | null;
  /** Role from the opening prompt, e.g. "dev" / "judge" / "mark-done". Null when unparseable. */
  role: string | null;
  /** Attempt from the opening prompt. Undefined when the prompt omits it. */
  attempt: number | undefined;
  /** ISO timestamp of the transcript's first line. Null when the file is empty. */
  startedAt: string | null;
  /**
   * ISO timestamp of the last line that carried one. With `startedAt` it bounds the
   * window an external CLI this agent drove must have started inside.
   */
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
  /** Every model that produced a billed turn, in first-seen order, deduplicated. */
  models: string[];
  counts: TokenCounts;
  /**
   * Spend of the codex CLI run this agent drove, kept OUT of `counts` on purpose.
   * A dev-codex row is a cheap Haiku driver plus an expensive external model, and
   * one merged figure would hide which side burned what. Undefined for an agent
   * that drove no external CLI — never a zeroed object, which would read as a
   * measured "codex did nothing".
   */
  codexCounts?: TokenCounts;
};

/** Plan-wide usage, addressed by task and in aggregate. */
export type UsageRollup = {
  /** Task ref -> counts, summed over every agent that named that ref. */
  byTask: Record<string, TokenCounts>;
  /** Counts from agents whose task ref could not be parsed. */
  unattributed: TokenCounts;
  /** Every counted token from every discovered agent. */
  totals: TokenCounts;
  /** How many agent transcripts fed this rollup. */
  agentCount: number;
  /** Task ref -> codex counts, for the tasks whose agents drove the codex CLI. */
  codexByTask: Record<string, TokenCounts>;
  /** Every codex token joined to this plan. Zero when no task used an external engine. */
  codexTotals: TokenCounts;
  /** How many codex runs were joined. Zero means "no codex", not "codex spent nothing". */
  codexRunCount: number;
};
