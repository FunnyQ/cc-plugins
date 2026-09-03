#!/usr/bin/env bun
import { errorMessage } from "../../../shared/scripts/errors";
import type { Provider } from "./analyze-branch";

export type CreateInput = {
  provider: Provider;
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
  // Target repo ("owner/name"), set only when the request cannot be inferred from
  // the remotes — i.e. `origin` is upstream and the branch lives on a fork remote,
  // with `head` already qualified as "owner:branch". Left unset in gh's own fork
  // workflow (origin = the fork), where gh correctly defaults to the parent repo
  // and forcing --repo would open a fork→fork PR instead.
  repo?: string;
  // The user answered "no review needed" at the skill's review gate. The marker
  // is stamped onto the title here so review automation reads a fixed string.
  skipReview?: boolean;
};

export const SKIP_REVIEW_SUFFIX = "[skip-review]";

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

export function resolveTitle(input: CreateInput): string {
  if (!input.skipReview) {
    return input.title;
  }

  const title = input.title.trimEnd();

  return title.endsWith(SKIP_REVIEW_SUFFIX)
    ? title
    : `${title} ${SKIP_REVIEW_SUFFIX}`;
}

export function buildArgs(input: CreateInput): string[] {
  const title = resolveTitle(input);

  if (input.provider === "github") {
    const args = ["gh", "pr", "create"];

    if (input.repo) {
      args.push("--repo", input.repo);
    }

    args.push(
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      title,
      "--body",
      input.body,
    );

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
    title,
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

function stderrMessage(stderr: string, fallback: string): string {
  return stderr.trim() || fallback;
}

export async function createRequest(
  input: CreateInput,
  run: Runner,
): Promise<CreateResult> {
  // analyze-branch emits "unknown" for any remote that is neither host; there is no
  // CLI to reach for, so refuse here rather than let buildArgs guess a binary.
  if (input.provider === "unknown") {
    return {
      ok: false,
      reason: "cli-error",
      message:
        "Unknown provider: the remote is neither GitHub nor GitLab, so no request CLI applies.",
    };
  }

  const binary = binaryForProvider(input.provider);

  // No `command -v` preflight: a missing binary makes the spawn below throw ENOENT,
  // which isMissingExecutable already maps to the same missing-cli result.
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
      message: errorMessage(error),
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
      message: stderrMessage(result.stderr, "No repository remote was found."),
    };
  }

  return {
    ok: false,
    reason: "cli-error",
    message: stderrMessage(result.stderr, "Request CLI failed."),
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
      message: errorMessage(error),
    };
    console.log(JSON.stringify(result));
  }
}
