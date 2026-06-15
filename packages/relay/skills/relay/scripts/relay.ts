#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Backend, InvokeOpts, Mode, RunResult } from "./types";
import { capabilityGate, getBackend } from "./backends/gate";
import { BACKENDS } from "./backends";
import { buildPromptFile } from "./relay-prompt";
import { createTmpRunDir, resolveModel, run } from "./shared";

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
  fileExists: (path: string) => boolean;
  run: (argv: string[], opts?: { stdin?: string }) => RunResult;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
};

export type RelayExecution = {
  code: number;
  dir?: string;
  lastFile?: string;
  lastMd?: string;
};

class UsageError extends Error {}

function usage(backends: string): string {
  return [
    `Usage: relay <${backends}> <delegate|review|image> [flags]`,
    "flags: --task <text> | --files <csv> | --focus <text>",
    "       --scope <uncommitted|base:<ref>|commit:<sha>|custom-files>",
    "       --model <provider/model> | --out <path> | --git-scope <s> | --no-project",
    "       --prompt-file <p> | --dangerous",
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
  };
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (arg === "--task") {
      flags.task = requireValue(rest, i, arg);
      i++;
    } else if (arg === "--files") {
      flags.files = requireValue(rest, i, arg)
        .split(",")
        .map((file) => file.trim())
        .filter(Boolean);
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
    } else if (arg === "--no-project") {
      flags.noProject = true;
    } else if (arg === "--dangerous") {
      flags.dangerous = true;
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

export function executeRelay(
  argv: string[],
  deps: RelayDeps = {
    registry: BACKENDS,
    createTmpRunDir,
    buildPromptFile,
    readFile: (path) => readFileSync(path, "utf-8"),
    writeFile: (path, text) => writeFileSync(path, text, "utf-8"),
    fileExists: existsSync,
    run,
    stderr: (text) => process.stderr.write(text),
    stdout: (text) => process.stdout.write(text),
  },
): RelayExecution {
  let parsed: ParsedFlags;
  const availableBackends = Object.keys(deps.registry).join("|");

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
  const dir = deps.createTmpRunDir();
  const opts: InvokeOpts = {
    task,
    focus,
    scope: parsed.flags.scope ?? "uncommitted",
    out: parsed.flags.out ?? "relay-image.png",
    model: resolveModel(parsed.backend, parsed.mode, parsed.flags.model),
    lastFile: join(dir, "raw.txt"),
    dangerous: parsed.flags.dangerous,
  };

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
  const finalOutput = backend.postRun
    ? backend.postRun(parsed.mode, parsedOutput, opts)
    : parsedOutput;

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
  const result = executeRelay(process.argv.slice(2));
  process.exit(result.code);
}
