export type DeckState =
  | "done"
  | "in-progress"
  | "ready"
  | "blocked"
  | "invalid";

export type DeckTask = {
  ref: string; // "bucket/NN", or the graph node id
  title: string;
  state: DeckState;
  attempts: number;
  score: { weighted: number; threshold: number; passed: boolean } | null;
  time: { startedAt: string; endedAt: string | null } | null; // first agent start to last finish; endedAt null while one runs
  tokens: number | null; // billed total, done tasks only, and only from a --usage run
};

export type DeckAgent = {
  role: string; // FleetRow.role
  ref: string | null;
  attempt: number | null;
  label: string;
  startedAt: string | null; // ISO; the pane renders elapsed from it at draw time
};

// a fleet row with no task card to ride (scout, commit), kept after it ends as the web fleet keeps it
export type DeckCrew = {
  role: string;
  label: string;
  status: "in-flight" | "finished" | "abandoned";
  startedAt: string | null; // ISO; in-flight elapsed is drawn from it
  elapsedMs: number | null; // a finished row's duration
};

export type DeckSnapshot = {
  deckSource: "tasks" | "graph";
  plan: string; // absolute plan dir
  slug: string;
  planTitle: string;
  counts: {
    total: number;
    done: number;
    inProgress: number;
    ready: number;
    blocked: number;
    invalid: number;
  };
  buckets: { name: string; done: number; total: number }[]; // TreePayload.buckets order
  waves: string[][]; // waves[0] = wave 1; refs in TreePayload.tasks order
  unschedulable: string[]; // refs no layer reaches (cycle, dangling dep), sorted
  currentWave: number | null; // 1-based: lowest wave holding a non-done task; null when no wave holds one (all done, or only unschedulable work left)
  tasks: Record<string, DeckTask>;
  agents: DeckAgent[]; // FleetRow.status === "in-flight" only, startedAt ascending
  crew: DeckCrew[];
  time: DeckTask["time"]; // the whole run: first agent start to last finish, open while one runs
  tokens: number | null; // the whole run's billed tokens, crew included, only from a --usage run // the latest 3 taskless fleet rows of any status, newest first
  errors: number; // TreePayload.errors.length
};
