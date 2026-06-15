export type Mode = "delegate" | "review" | "image";
export type Strategy = "native" | "prompt";

export type RunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

// What relay.ts hands a backend after parsing argv + (maybe) building a prompt.
// This is the single shared seam — backends must not invent their own extensions.
export type InvokeOpts = {
  promptFile?: string; // path to the built prompt (strategy === "prompt"); codex feeds it on stdin
  promptText?: string; // prompt body already read from promptFile, for CLIs with no --prompt-file flag (opencode/claude)
  task?: string; // raw task/focus text (e.g. codex image prompt source)
  scope?: string; // native review scope: "uncommitted" | "base:<ref>" | "commit:<sha>" | "custom-files"
  focus?: string; // user's specific concern (review) / effort level
  out?: string; // image output path
  model?: string; // resolved model (may be undefined → CLI default)
  lastFile?: string; // pre-created output-capture path (codex `-o <lastFile>`); relay creates the tmp dir first
  dangerous?: boolean; // delegate sandbox opt-out
  runStartedAt?: Date; // wall-clock just before the backend spawn (codex image: cutoff for newest-PNG search)
};

// Optional post-run side effect (e.g. codex image PNG copy). Returning {ok:false}
// lets relay surface a non-zero exit instead of treating the error text as success.
export type PostRunResult = { ok: boolean; text: string };

export type Backend = {
  name: string; // registry key (codex/opencode/claude today) — string so a 4th backend needs no core edit
  supports: Set<Mode>;
  strategy(mode: Mode, opts: InvokeOpts): Strategy;
  // Build the argv (and optional stdin) for this mode. Pure — no spawning here.
  invoke(mode: Mode, opts: InvokeOpts): { argv: string[]; stdin?: string };
  // Extract clean final text from a completed run (file content or stdout).
  parseOutput(raw: string): string;
  // Optional post-run step run by relay.ts AFTER the spawn + parseOutput. Receives the parsed
  // text + opts, returns the final text relay prints. This is the generic seam for backend-only
  // side effects (e.g. codex image: locate the PNG, copy it to opts.out, return "Image saved: <path>").
  // relay.ts calls `b.postRun ? b.postRun(mode, parsed, opts) : ...` — no backend-name branching.
  postRun?(mode: Mode, parsed: string, opts: InvokeOpts): PostRunResult;
};
