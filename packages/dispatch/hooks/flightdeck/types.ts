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
};

export type DeckAgent = {
  role: string; // FleetRow.role
  ref: string | null;
  attempt: number | null;
  label: string;
  startedAt: string | null; // ISO; the pane renders elapsed from it at draw time
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
  errors: number; // TreePayload.errors.length
};
