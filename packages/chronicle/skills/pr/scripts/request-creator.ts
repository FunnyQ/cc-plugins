#!/usr/bin/env bun

type Provider = "github" | "gitlab";

export type CreateInput = {
  provider: Provider;
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
};

export type CreateResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: "missing-cli" | "no-remote" | "cli-error";
      message: string;
    };

export type Runner = (
  cmd: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

function binaryForProvider(provider: Provider): "gh" | "glab" {
  return provider === "github" ? "gh" : "glab";
}

export function buildArgs(input: CreateInput): string[] {
  if (input.provider === "github") {
    const args = [
      "gh",
      "pr",
      "create",
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body,
    ];

    if (input.draft) {
      args.push("--draft");
    }

    return args;
  }

  const args = [
    "glab",
    "mr",
    "create",
    "--source-branch",
    input.head,
    "--target-branch",
    input.base,
    "--title",
    input.title,
    "--description",
    input.body,
    "--yes",
  ];

  if (input.draft) {
    args.push("--draft");
  }

  return args;
}

function isMissingExecutable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function missingCliResult(binary: string): CreateResult {
  return {
    ok: false,
    reason: "missing-cli",
    message: `${binary} is not available on PATH. Install ${binary} and try again.`,
  };
}

function looksLikeNoRemote(stderr: string): boolean {
  const message = stderr.toLowerCase();

  return [
    "not a git repository",
    "no remote",
    "no remotes",
    "could not read from remote repository",
    "repository not found",
    "not a gitlab repository",
    "not a github repository",
  ].some((needle) => message.includes(needle));
}

function extractLastUrl(stdout: string): string | undefined {
  const matches = stdout.match(/https:\/\/\S+/g);
  return matches?.at(-1)?.replace(/[),.;]+$/, "");
}

function errorMessage(stderr: string, fallback: string): string {
  return stderr.trim() || fallback;
}

export async function createRequest(
  input: CreateInput,
  run: Runner,
): Promise<CreateResult> {
  const binary = binaryForProvider(input.provider);

  try {
    const preflight = await run(["sh", "-lc", `command -v ${binary}`]);
    if (preflight.exitCode !== 0) {
      return missingCliResult(binary);
    }
  } catch (error) {
    if (isMissingExecutable(error)) {
      return missingCliResult(binary);
    }

    return {
      ok: false,
      reason: "cli-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let result: Awaited<ReturnType<Runner>>;
  try {
    result = await run(buildArgs(input));
  } catch (error) {
    if (isMissingExecutable(error)) {
      return missingCliResult(binary);
    }

    return {
      ok: false,
      reason: "cli-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.exitCode === 0) {
    const url = extractLastUrl(result.stdout);

    if (url) {
      return { ok: true, url };
    }

    return {
      ok: false,
      reason: "cli-error",
      message: "Request CLI succeeded but did not print a URL.",
    };
  }

  if (looksLikeNoRemote(result.stderr)) {
    return {
      ok: false,
      reason: "no-remote",
      message: errorMessage(result.stderr, "No repository remote was found."),
    };
  }

  return {
    ok: false,
    reason: "cli-error",
    message: errorMessage(result.stderr, "Request CLI failed."),
  };
}

async function readInputJson(): Promise<string> {
  const argvInput = process.argv[2];
  if (argvInput) {
    return argvInput;
  }

  return await Bun.stdin.text();
}

async function realRunner(cmd: string[]): ReturnType<Runner> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);

  return {
    exitCode,
    stdout,
    stderr,
  };
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await readInputJson()) as CreateInput;
    const result = await createRequest(input, realRunner);
    console.log(JSON.stringify(result));
  } catch (error) {
    const result: CreateResult = {
      ok: false,
      reason: "cli-error",
      message: error instanceof Error ? error.message : String(error),
    };
    console.log(JSON.stringify(result));
  }
}
