/**
 * Advisory commit grouping from TypeSafe's Jev model, used only when
 * `TYPESAFE_API_KEY` is set. It saves the Lawspeaker the grouping pass, never
 * the ordering: which order lets every commit build is an import question, and
 * the Lawspeaker still owns it. Every failure degrades to "no suggestion".
 */

import { askJev, type JevAnswer, type JevQuestion } from "../../../shared/scripts/typesafe";

/** Pairs grow as N²/2 — 20 files is 190 questions. */
const MAX_FILES = 20;
/** Jev caps state plus the longest question at 32k tokens; ~4 chars per token. */
const STATE_CHAR_BUDGET = 60_000;
const MAX_EXCERPT_LINES = 40;
const SAME_GROUP_THRESHOLD = 0.7;

const TYPES: Record<string, string> = {
  feat: "Adds a new user-facing capability",
  fix: "Corrects a bug or wrong behaviour",
  docs: "Changes documentation or prose only",
  style: "Formatting only, no behaviour change",
  refactor: "Restructures code without changing behaviour",
  perf: "Makes existing behaviour faster or cheaper",
  test: "Adds or changes tests only",
  chore: "Build, dependency, config, or tooling upkeep",
};

export type GroupInput = {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  diff: string;
};


export type Group = { files: string[]; types: string[] };
/** `ms` is the round trip, so the user sees what the call cost this commit. */
export type Suggestion =
  | { groups: Group[]; ms: number }
  | { skipped: string; ms?: number };

export function buildRequest(input: GroupInput[]) {
  const seen = new Set<string>();
  const files = input.filter((f) => !seen.has(f.path) && seen.add(f.path));
  const excerptChars = Math.floor(STATE_CHAR_BUDGET / files.length);

  const state = {
    files: files.map((f, index) => ({
      index,
      path: f.path,
      status: f.status,
      stats: `+${f.insertions}/-${f.deletions}`,
      excerpt: f.diff
        .split("\n")
        .slice(0, MAX_EXCERPT_LINES)
        .join("\n")
        .slice(0, excerptChars),
    })),
  };

  const questions: Record<string, JevQuestion> = {};
  files.forEach((_, i) => {
    questions[`type:${i}`] = {
      type: "choice",
      instructions: `Which conventional-commit type best describes the change to \`files[${i}]\`?`,
      criteria: TYPES,
    };
  });
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      questions[`pair:${i}:${j}`] = {
        type: "noul",
        instructions: `Do the changes to \`files[${i}]\` and \`files[${j}]\` belong in the same git commit?`,
        criteria: {
          true: "Same concern: one change, a test and the code it tests, or one file cannot work without the other's change",
          false:
            "Unrelated concerns that could be committed and reviewed separately",
        },
      };
    }
  }

  return { state, questions };
}

export function groupFromAnswers(
  paths: string[],
  answers: Record<string, JevAnswer>,
  threshold = SAME_GROUP_THRESHOLD,
): Group[] {
  const parent = paths.map((_, i) => i);
  const root = (i: number): number =>
    parent[i] === i ? i : (parent[i] = root(parent[i]!));

  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      if ((answers[`pair:${i}:${j}`]?.noul ?? 0) >= threshold) {
        parent[root(j)] = root(i);
      }
    }
  }

  const byRoot = new Map<number, Group>();
  paths.forEach((path, i) => {
    const group = byRoot.get(root(i)) ?? { files: [], types: [] };
    group.files.push(path);
    group.types.push(answers[`type:${i}`]?.choice ?? "?");
    byRoot.set(root(i), group);
  });
  return [...byRoot.values()];
}

export async function suggestGroups(
  files: GroupInput[],
  opts: { apiKey: string | undefined; fetch?: typeof fetch },
): Promise<Suggestion> {
  if (!opts.apiKey) return { skipped: "TYPESAFE_API_KEY not set" };
  const unique = new Set(files.map((f) => f.path)).size;
  if (unique < 2) return { skipped: `${unique} file, nothing to group` };
  if (unique > MAX_FILES) {
    return { skipped: `${unique} files, over the ${MAX_FILES}-file limit` };
  }

  const body = buildRequest(files);
  const result = await askJev(body, opts);
  if ("skipped" in result) return result;
  const paths = body.state.files.map((f) => f.path);
  return { groups: groupFromAnswers(paths, result.answers), ms: result.ms };
}

export function renderSuggestion(suggestion: Suggestion): string {
  if ("skipped" in suggestion) {
    const after = suggestion.ms === undefined ? "" : ` after ${suggestion.ms} ms`;
    return `\n[TypeSafe grouping skipped${after}: ${suggestion.skipped}]\n`;
  }
  const lines = suggestion.groups.map(
    (group, i) =>
      `${i + 1}. ${group.files.map((f, k) => `${f} [${group.types[k]}]`).join(", ")}`,
  );
  return [
    "",
    "## Suggested groups (TypeSafe, advisory — unordered)",
    ...lines,
    "",
    `[TypeSafe grouping: ${suggestion.ms} ms]`,
    "",
  ].join("\n");
}
