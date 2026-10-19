export type Mode = "delegate" | "review" | "image";

export type RunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

export type InvokeOpts = {
  promptText?: string; // the built prompt body — every CLI takes it inline (codex on stdin, opencode after --, claude via -p)
  task?: string; // raw delegate, review, or image task
  out?: string; // image output path (--out; the backend owns the default)
  model?: string; // resolved model (may be undefined → CLI default)
  effort?: string; // claude-only reasoning effort (--effort); undefined → CLI default
  lastFile?: string; // pre-created output-capture path (codex `-o <lastFile>`); relay creates the tmp dir first
  dangerous?: boolean; // delegate sandbox opt-out
  runStartedAt?: Date; // wall-clock just before the backend spawn (codex image: cutoff for newest-PNG search)
};

export type PostRunResult = { ok: boolean; text: string };

export type LiveSpec = {
  agentBin: string; // interactive TUI binary
  argv: string[];
};

export type Backend = {
  name: string; // registry key (codex/opencode/claude today) — string so a 4th backend needs no core edit
  supports: Set<Mode>;
  invoke(mode: Mode, opts: InvokeOpts): { argv: string[]; stdin?: string };
  parseOutput(raw: string): string;
  postRun?(mode: Mode, parsed: string, opts: InvokeOpts): PostRunResult;
  // Optional: pull the real error out of a failed run's stdout, for CLIs that
  // exit non-zero with empty stderr (opencode reports it as a JSONL event).
  parseError?(stdout: string): string | undefined;
  invokeLive?(mode: Mode, opts: InvokeOpts): LiveSpec | null;
};
