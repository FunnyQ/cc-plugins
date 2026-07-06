#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Backend, InvokeOpts, Mode, RunResult } from "./types";
import { capabilityGate, getBackend } from "./backends/gate";
import { BACKENDS } from "./backends";
import {
  appendFileContract,
  buildPromptFile,
  scopeInstruction,
} from "./relay-prompt";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  liveGate,
  resolveHerdScript,
  runLive,
  type LiveRunResult,
  type RunLiveOpts,
} from "./live";
import {
  CONFIG_PATH,
  createTmpRunDir,
  parseCsv,
  resolveModel,
  run,
} from "./shared";

const MODES = new Set<Mode>(["delegate", "review", "image"]);

export type RelayFlags = {
  task?: string;
  files: string[];
  focus?: string;
  scope?: string;
  model?: string;
  out?: string;
  gitScope: "all" | "related" | "none";
  noProject: boolean;
  promptFile?: string;
  dangerous: boolean;
  headless: boolean; // opt out of the live-pane path even inside herdr
  waitTimeoutMs?: number; // live poll budget (--wait-timeout, default 10 min)
};

export type ParsedFlags = {
  backend?: string;
  mode?: string;
  flags: RelayFlags;
  positional: string;
};

export type RelayDeps = {
  registry: Record<string, Backend>;
  createTmpRunDir: () => string;
  buildPromptFile: typeof buildPromptFile;
  readFile: (path: string) => string;
  writeFile: (path: string, text: string) => void;
  ensureDir: (path: string) => void;
  fileExists: (path: string) => boolean;
  run: (argv: string[], opts?: { stdin?: string }) => RunResult;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
  env: Record<string, string | undefined>;
  resolveHerdScript: () => string | null;
  runLive: (opts: RunLiveOpts) => Promise<LiveRunResult>;
};

export type RelayExecution = {
  code: number;
  dir?: string;
  lastFile?: string;
  lastMd?: string;
  agentName?: string; // live runs: the herd agent name (pane target)
  pending?: boolean; // live timeout: still running, exit 0, collect via herd
};

class UsageError extends Error {}

function usage(backends: string): string {
  return [
    `Usage: relay <${backends}> <delegate|review|image> [flags]`,
    `       relay config set-model <${backends}> <delegate|review|image> <model>`,
    "flags: --task <text> | --files <csv> | --focus <text>",
    "       --scope <uncommitted|base:<ref>|commit:<sha>|custom-files>",
    "       --model <provider/model> | --out <path> | --git-scope <s> | --no-project",
    "       --prompt-file <p> | --dangerous",
    "       --headless | --wait-timeout <ms>   (live-pane runs inside herdr)",
  ].join("\n");
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

export function parseFlags(argv: string[]): ParsedFlags {
  const [backend, mode, ...rest] = argv;
  const flags: RelayFlags = {
    files: [],
    gitScope: "related",
    noProject: false,
    dangerous: false,
    headless: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (arg === "--task") {
      flags.task = requireValue(rest, i, arg);
      i++;
    } else if (arg === "--files") {
      flags.files = parseCsv(requireValue(rest, i, arg));
      i++;
    } else if (arg === "--focus") {
      flags.focus = requireValue(rest, i, arg);
      i++;
    } else if (arg === "--scope") {
      flags.scope = requireValue(rest, i, arg);
      i++;
    } else if (arg === "--model") {
      flags.model = requireValue(rest, i, arg);
      i++;
    } else if (arg === "--out") {
      flags.out = requireValue(rest, i, arg);
      i++;
    } else if (arg === "--git-scope") {
      const value = requireValue(rest, i, arg);
      if (value !== "all" && value !== "related" && value !== "none") {
        throw new UsageError("--git-scope must be all, related, or none");
      }
      flags.gitScope = value;
      i++;
    } else if (arg === "--prompt-file") {
      flags.promptFile = requireValue(rest, i, arg);
      i++;
    } else if (arg === "--wait-timeout") {
      const value = Number(requireValue(rest, i, arg));
      if (!Number.isFinite(value) || value <= 0) {
        throw new UsageError(
          "--wait-timeout must be a positive number of milliseconds",
        );
      }
      flags.waitTimeoutMs = value;
      i++;
    } else if (arg === "--no-project") {
      flags.noProject = true;
    } else if (arg === "--dangerous") {
      flags.dangerous = true;
    } else if (arg === "--headless") {
      flags.headless = true;
    } else if (arg.startsWith("--")) {
      throw new UsageError(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { backend, mode, flags, positional: positional.join(" ") };
}

function isMode(mode: string | undefined): mode is Mode {
  return mode !== undefined && MODES.has(mode as Mode);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(
  path: string,
  deps: RelayDeps,
): Record<string, unknown> {
  if (!deps.fileExists(path)) return {};

  const parsed = JSON.parse(deps.readFile(path));
  return isObject(parsed) ? parsed : {};
}

function mergeModelConfig(
  config: Record<string, unknown>,
  backend: string,
  mode: Mode,
  model: string,
): Record<string, unknown> {
  const models = isObject(config.models) ? config.models : {};
  const backendModels = isObject(models[backend]) ? models[backend] : {};

  return {
    ...config,
    models: {
      ...models,
      [backend]: {
        ...backendModels,
        [mode]: model,
      },
    },
  };
}

async function executeConfigCommand(
  argv: string[],
  deps: RelayDeps,
  availableBackends: string,
): Promise<RelayExecution> {
  const [, subcommand, backendName, modeName, model, ...extra] = argv;

  if (
    subcommand !== "set-model" ||
    !backendName ||
    !modeName ||
    !model ||
    extra.length > 0
  ) {
    deps.stderr(
      `Usage: relay config set-model <${availableBackends}> <delegate|review|image> <model>\n`,
    );
    return { code: 1 };
  }

  if (!getBackend(deps.registry, backendName)) {
    deps.stderr(`Unknown backend: ${backendName}\n`);
    return { code: 1 };
  }

  if (!isMode(modeName)) {
    deps.stderr(`Unknown mode: ${modeName}\n`);
    return { code: 1 };
  }

  let config: Record<string, unknown>;
  try {
    config = readJsonObject(CONFIG_PATH, deps);
  } catch (error) {
    deps.stderr(
      `Could not read relay config: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return { code: 1 };
  }

  const nextConfig = mergeModelConfig(config, backendName, modeName, model);
  deps.ensureDir(dirname(CONFIG_PATH));
  deps.writeFile(CONFIG_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`);
  deps.stdout(`Saved default model for ${backendName} ${modeName}: ${model}\n`);
  return { code: 0 };
}

function promptTextForMode(
  mode: Mode,
  flags: RelayFlags,
  positional: string,
): { task: string; focus: string } {
  const task =
    flags.task ?? (mode === "delegate" || mode === "image" ? positional : "");
  const focus = flags.focus ?? (mode === "review" ? positional : "");
  return { task, focus };
}

export async function executeRelay(
  argv: string[],
  deps: RelayDeps = {
    registry: BACKENDS,
    createTmpRunDir,
    buildPromptFile,
    readFile: (path) => readFileSync(path, "utf-8"),
    writeFile: (path, text) => {
      // Defensive: ensure the parent scratch dir exists right before writing.
      // The run dir is created up front, but an external CLI runs in between;
      // re-creating the dir here keeps the output-contract write from crashing
      // if anything disturbed it mid-run.
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "utf-8");
    },
    ensureDir: (path) => mkdirSync(path, { recursive: true }),
    fileExists: existsSync,
    run,
    stderr: (text) => process.stderr.write(text),
    stdout: (text) => process.stdout.write(text),
    env: process.env,
    resolveHerdScript: () => resolveHerdScript(),
    runLive: (opts) => runLive(opts),
  },
): Promise<RelayExecution> {
  let parsed: ParsedFlags;
  const availableBackends = Object.keys(deps.registry).join("|");

  if (argv[0] === "config") {
    return executeConfigCommand(argv, deps, availableBackends);
  }

  try {
    parsed = parseFlags(argv);
  } catch (error) {
    deps.stderr(
      `${error instanceof Error ? error.message : String(error)}\n${usage(
        availableBackends,
      )}\n`,
    );
    return { code: 1 };
  }

  const backend = parsed.backend
    ? getBackend(deps.registry, parsed.backend)
    : undefined;
  if (!parsed.backend || !backend) {
    deps.stderr(
      `Unknown backend: ${parsed.backend ?? "(missing)"}\n${usage(
        availableBackends,
      )}\n`,
    );
    return { code: 1 };
  }

  if (!isMode(parsed.mode)) {
    deps.stderr(
      `Unknown mode: ${parsed.mode ?? "(missing)"}\n${usage(
        availableBackends,
      )}\n`,
    );
    return { code: 1 };
  }

  const gateError = capabilityGate(backend, parsed.mode);
  if (gateError) {
    deps.stderr(`${gateError}\n`);
    return { code: 1 };
  }

  const { task, focus } = promptTextForMode(
    parsed.mode,
    parsed.flags,
    parsed.positional,
  );

  if (parsed.mode === "image" && !task.trim()) {
    deps.stderr(
      "image mode requires a prompt (pass it as the positional text or --task)\n",
    );
    return { code: 1 };
  }

  const dir = deps.createTmpRunDir();
  // A review naming explicit files (without an explicit scope) is a custom-file
  // review — route it to the prompt strategy instead of falling through to a
  // native uncommitted-diff review that would ignore --files.
  const defaultScope =
    parsed.mode === "review" && parsed.flags.files.length > 0
      ? "custom-files"
      : "uncommitted";
  const opts: InvokeOpts = {
    task,
    focus,
    scope: parsed.flags.scope ?? defaultScope,
    out: parsed.flags.out ?? "relay-image.png",
    model: resolveModel(parsed.backend, parsed.mode, parsed.flags.model),
    lastFile: join(dir, "raw.txt"),
    dangerous: parsed.flags.dangerous,
  };

  // Live-pane routing: inside herdr (HERDR_ENV=1), delegate/review runs in a
  // visible sibling pane instead of a blocking headless spawn. Everything here
  // is optional — any denial (or a pre-spawn runner error) falls through to
  // the unchanged headless flow below.
  const insideHerdr = deps.env.HERDR_ENV === "1";
  const herdScriptPath = insideHerdr ? deps.resolveHerdScript() : null;
  const gate = liveGate({
    env: deps.env,
    headless: parsed.flags.headless,
    mode: parsed.mode,
    backend,
    herdScriptPath,
  });
  if (!gate.live && gate.reason) {
    deps.stderr(
      `[relay] live mode unavailable (${gate.reason}); running headless\n`,
    );
  }

  // The gate only checks that a live seam EXISTS; invokeLive may still decline a
  // specific mode by returning null (the type is `LiveSpec | null` — codex image
  // already does this). Resolve it here so a null cleanly degrades to headless
  // instead of force-unwrapping to a crash below.
  const liveSpec = gate.live ? backend.invokeLive!(parsed.mode, opts) : null;
  if (gate.live && !liveSpec) {
    deps.stderr(
      `[relay] ${backend.name} has no live path for ${parsed.mode}; running headless\n`,
    );
  }

  if (gate.live && liveSpec) {
    // Live always uses the prompt strategy — there is no native `codex review`
    // inside a TUI; a git-ref scope becomes a produce-the-diff-yourself
    // instruction appended below.
    const promptFile =
      parsed.flags.promptFile ??
      deps.buildPromptFile({
        kind: parsed.mode as "delegate" | "review",
        files: parsed.flags.files,
        focus,
        task,
        gitScope: parsed.flags.gitScope,
        noProject: parsed.flags.noProject,
      });
    const promptText = deps.readFile(promptFile);
    const resultPath = join(dir, "result.md");
    const scopeNote =
      parsed.mode === "review" ? scopeInstruction(opts.scope) : "";
    const livePrompt = appendFileContract(
      scopeNote ? `${promptText}\n\n${scopeNote}` : promptText,
      resultPath,
    );
    // The full prompt rides a file — a multi-line herd.send submits prematurely
    // in TUI inputs (and risks ARG_MAX); the pane only gets a one-line bootstrap.
    const livePromptPath = join(dir, "live-prompt.md");
    deps.writeFile(livePromptPath, livePrompt);
    const bootstrapText = `Read the file ${livePromptPath} and follow its instructions exactly, including the result-file instructions at the end.`;

    const liveResult = await deps.runLive({
      backend: parsed.backend,
      mode: parsed.mode,
      spec: liveSpec,
      herdScriptPath: herdScriptPath!,
      bootstrapText,
      resultPath,
      cwd: process.cwd(),
      waitTimeoutMs: parsed.flags.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    });

    if (liveResult.ok) {
      // result.md is already the delegate's clean final markdown — no
      // parseOutput/postRun (those exist for headless stream/image handling).
      if (!liveResult.text.trim()) {
        deps.stderr("Live run produced empty output\n");
        return { code: 1, dir, agentName: liveResult.agentName };
      }
      const lastMd = join(dir, "last.md");
      deps.writeFile(lastMd, liveResult.text);
      // stdout carries ONLY the answer; live metadata rides stderr so piping
      // the result stays clean.
      deps.stdout(liveResult.text);
      deps.stderr(
        `\n[relay live] agent ${liveResult.agentName} — pane left open (confirm close-or-keep; \`herd close ${liveResult.agentName}\` to close)\n`,
      );
      return { code: 0, dir, lastMd, agentName: liveResult.agentName };
    }

    if (liveResult.pending) {
      // Still running is NOT a failure: exit 0 with a follow-up report.
      deps.stdout(liveResult.report);
      return { code: 0, dir, agentName: liveResult.agentName, pending: true };
    }

    if (liveResult.agentName) {
      // Post-spawn failure: a pane may be mid-flight — do NOT double-run the
      // task headless; surface the error instead.
      deps.stderr(`Live run failed: ${liveResult.error}\n`);
      return { code: 1, dir, agentName: liveResult.agentName };
    }

    // Pre-spawn failure (herd.ts failed to load/spawn): nothing is running —
    // fall through to the headless flow in this same invocation.
    deps.stderr(
      `[relay] live spawn unavailable (${liveResult.error}); falling back to headless\n`,
    );
  }

  const strategy = backend.strategy(parsed.mode, opts);
  if (strategy === "prompt") {
    if (parsed.mode === "image") {
      deps.stderr("image mode does not support prompt strategy\n");
      return { code: 1, dir, lastFile: opts.lastFile };
    }

    opts.promptFile =
      parsed.flags.promptFile ??
      deps.buildPromptFile({
        kind: parsed.mode,
        files: parsed.flags.files,
        focus,
        task,
        gitScope: parsed.flags.gitScope,
        noProject: parsed.flags.noProject,
      });
    opts.promptText = deps.readFile(opts.promptFile);
  }

  const invocation = backend.invoke(parsed.mode, opts);
  opts.runStartedAt = new Date();
  const result = deps.run(invocation.argv, { stdin: invocation.stdin });

  if (!result.ok) {
    deps.stderr(
      result.stderr ||
        `Backend command failed with exit code ${result.code}: ${invocation.argv.join(
          " ",
        )}\n`,
    );
    return { code: result.code, dir, lastFile: opts.lastFile };
  }

  const raw =
    opts.lastFile && deps.fileExists(opts.lastFile)
      ? deps.readFile(opts.lastFile)
      : result.stdout;
  const parsedOutput = backend.parseOutput(raw);
  const postRun = backend.postRun
    ? backend.postRun(parsed.mode, parsedOutput, opts)
    : { ok: true, text: parsedOutput };

  // A failed post-run step (e.g. codex image: no PNG found / copy failed) must
  // exit non-zero — its error text is non-empty, so it would otherwise sail
  // past the empty-output check below and report success.
  if (!postRun.ok) {
    deps.stderr(
      postRun.text.endsWith("\n") ? postRun.text : `${postRun.text}\n`,
    );
    return { code: 1, dir, lastFile: opts.lastFile };
  }

  const finalOutput = postRun.text;
  if (!finalOutput.trim()) {
    deps.stderr("Backend command produced empty output\n");
    return { code: 1, dir, lastFile: opts.lastFile };
  }

  const lastMd = join(dir, "last.md");
  deps.writeFile(lastMd, finalOutput);
  deps.stdout(finalOutput);
  return { code: 0, dir, lastFile: opts.lastFile, lastMd };
}

if (import.meta.main) {
  const result = await executeRelay(process.argv.slice(2));
  process.exit(result.code);
}
