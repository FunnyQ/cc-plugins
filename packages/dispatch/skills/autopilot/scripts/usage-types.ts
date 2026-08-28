// No imports on purpose: `fleet.ts` will import `TokenCounts` from here, so this
// file must depend on nothing or that edge becomes a cycle. Do not "fix" this back in.

/**
 * The four counters Claude Code writes on every billed assistant turn.
 * All four are collected even though only `input` and `output` are rendered —
 * they arrive in one object, so dropping two would cost more code than keeping them.
 */
export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

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
  /** Every model that produced a billed turn, in first-seen order, deduplicated. */
  models: string[];
  counts: TokenCounts;
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
};
