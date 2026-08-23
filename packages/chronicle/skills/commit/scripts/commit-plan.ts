/**
 * Commit plan model.
 *
 * A commit run is a short ordered list of commits. Which shape the changeset
 * takes, whether the plan covers it, what each message reads like, and how much
 * of the plan a previous run already landed — all of it is decided here, and all
 * of it is pure. Reading git belongs to `commit.ts`, which hands these functions
 * what it read.
 *
 * These were prose rules spread across three agents before. Prose cannot be
 * unit-tested, and the staging rules in particular had already been wrong twice.
 */

import type { ParsedStatus } from "./analyze-changes";

/** One cohesive group of files, as proposed by the watcher. */
export type CommitGroup = {
  /** Optional: derived from `type` when absent. See `emojiFor`. */
  emoji?: string;
  type: string;
  subject: string;
  /** Repo-root-relative. A rename carries both its old and its new path. */
  files: string[];
};

/** A group once the Lawspeaker has written its prose. */
export type PlannedCommit = CommitGroup & {
  /** English markdown body. Omitted for a trivial one-liner. */
  body?: string;
  /** 繁體中文摘要. Omitted for a trivial one-liner. */
  summary?: string;
};

export type CommitPlan = {
  shape: "simple" | "atomic";
  commits: PlannedCommit[];
};

export type ShapeDecision = {
  shape: "simple" | "atomic";
  /** Why — one line per signal that fired. Empty for a simple shape. */
  reasons: string[];
};

/**
 * Simple or atomic, with no human gate.
 *
 * `moduleSpread` comes from the watcher rather than from the paths here: what
 * counts as a module is repo-specific (`packages/x` in a monorepo, `app/models`
 * in a Rails tree), and guessing it from segment counts splits one of those two
 * repos wrongly every time.
 */
export function decideShape(
  /** One entry per proposed group, in order — only the count and the types matter. */
  groupTypes: string[],
  opts: {
    mode: "auto" | "simple";
    totalFiles: number;
    moduleSpread: string[];
  },
): ShapeDecision {
  if (opts.mode === "simple") {
    return { shape: "simple", reasons: [] };
  }
  // Nothing to split. Every signal below would be a lie about a single group.
  if (groupTypes.length <= 1) {
    return { shape: "simple", reasons: [] };
  }

  const reasons: string[] = [];
  const changeTypes = [...new Set(groupTypes)];
  if (changeTypes.length >= 2) {
    reasons.push(
      `${changeTypes.length} change types: ${changeTypes.join(", ")}`,
    );
  }
  if (opts.moduleSpread.length >= 2) {
    reasons.push(
      `spans ${opts.moduleSpread.length} modules: ${opts.moduleSpread.join(", ")}`,
    );
  }
  if (opts.totalFiles > 5) {
    reasons.push(`${opts.totalFiles} files`);
  }

  return { shape: reasons.length > 0 ? "atomic" : "simple", reasons };
}

export type PlanValidation = {
  ok: boolean;
  /** Changed paths the plan never assigned. */
  missing: string[];
  /** Paths the plan assigned to more than one commit. */
  duplicated: string[];
  /** Paths the plan names that the changeset does not hold. */
  unknown: string[];
  /** Renames whose two halves are not in the same commit, as `old -> new`. */
  splitRenames: string[];
};

/**
 * Whether the plan covers the changeset exactly once.
 *
 * Run before anything is staged. A plan that drops a file produces a commit that
 * cannot build, and finding that out from the post-commit verification means
 * finding it out too late to fix cheaply.
 *
 * A rename must carry both halves in the *same* commit. Committing only the new
 * path leaves the old path's deletion staged behind: the tree ends up holding
 * both files, and the post-commit check catches it only once the broken commit
 * is already written. That is why this runs before anything is staged.
 */
export function validatePlan(
  plan: CommitPlan,
  changed: ParsedStatus[],
): PlanValidation {
  const required = new Set(changed.map((entry) => entry.path));
  const allowed = new Set(required);
  for (const entry of changed) {
    if (entry.oldPath) allowed.add(entry.oldPath);
  }

  const owner = new Map<string, number>();
  const duplicated: string[] = [];
  const unknown: string[] = [];

  for (const [index, commit] of plan.commits.entries()) {
    for (const path of commit.files) {
      if (owner.has(path)) {
        if (!duplicated.includes(path)) duplicated.push(path);
        continue;
      }
      owner.set(path, index);
      if (!allowed.has(path)) unknown.push(path);
    }
  }

  const missing = [...required].filter((path) => !owner.has(path));

  const splitRenames: string[] = [];
  for (const entry of changed) {
    if (!entry.oldPath) continue;
    // An unassigned new path is already reported as missing; don't say it twice.
    if (!owner.has(entry.path)) continue;
    if (owner.get(entry.oldPath) !== owner.get(entry.path)) {
      splitRenames.push(`${entry.oldPath} -> ${entry.path}`);
    }
  }

  return {
    ok:
      missing.length === 0 &&
      duplicated.length === 0 &&
      unknown.length === 0 &&
      splitRenames.length === 0,
    missing,
    duplicated,
    unknown,
    splitRenames,
  };
}

/**
 * What the watcher writes to disk: the groups, in commit order, plus the scalars
 * the shape decision needs. `shape` and `ok` are absent on purpose — the script
 * adds them, and a draft that already carries them was copied from the schema
 * rather than derived from the diff.
 */
export type ProposalDraft = {
  groups: CommitGroup[];
  /** The commit template, which the Lawspeaker reads. From analyze-changes stdout. */
  promptPath: string;
  mode?: "auto" | "simple";
  totalFiles?: number;
  elidedFiles?: number;
  /** Top-level modules the changeset spans — repo-shaped, so the watcher judges it. */
  moduleSpread?: string[];
  /** Why the groups are in this order. */
  notes?: string[];
  /** Set alone, with no groups, when there is nothing to commit. */
  nothingToCommit?: boolean;
};

function isFilledString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Whether a proposal draft is structurally usable, as a list of complaints.
 *
 * The watcher is a Haiku agent writing JSON by hand, so every field here has a
 * plausible way of arriving wrong: a group without files, an absolute path, the
 * shape it was told not to decide. Saying exactly what is wrong lets it fix the
 * file and re-run instead of handing the Lawspeaker something half-formed.
 *
 * Coverage of the changeset is `validatePlan`'s job — it needs git, this does not.
 */
export function validateProposalDraft(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["the proposal must be a JSON object"];
  }

  const draft = raw as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of ["shape", "reasons", "ok"]) {
    if (key in draft) {
      errors.push(`remove \`${key}\` — the script decides it, not you`);
    }
  }

  if (
    draft.mode !== undefined &&
    draft.mode !== "auto" &&
    draft.mode !== "simple"
  ) {
    errors.push('`mode` must be "auto" or "simple"');
  }

  // Required: the Lawspeaker reads the commit template from it, and it fails
  // there — past the point where re-running the watcher is still an option.
  if (!isFilledString(draft.promptPath)) {
    errors.push(
      "`promptPath` is missing — copy it from analyze-changes stdout",
    );
  }

  for (const key of ["moduleSpread", "notes"]) {
    const value = draft[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string")
    ) {
      // A bare string survives `.length` and then throws inside decideShape's
      // join, which reaches the watcher as a JS error it cannot act on.
      errors.push(`\`${key}\` must be an array of strings`);
    }
  }

  for (const key of ["totalFiles", "elidedFiles"]) {
    const value = draft[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push(`\`${key}\` must be a count, not ${JSON.stringify(value)}`);
    }
  }

  if (!Array.isArray(draft.groups) || draft.groups.length === 0) {
    errors.push("`groups` must be a non-empty array, in commit order");
    return errors;
  }

  for (const [index, entry] of draft.groups.entries()) {
    const at = `groups[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${at} must be an object`);
      continue;
    }

    const candidate = entry as Record<string, unknown>;
    if (!isFilledString(candidate.type)) {
      errors.push(`${at}.type is missing — feat / fix / docs / chore / …`);
    }
    if (!isFilledString(candidate.subject)) {
      errors.push(`${at}.subject is missing — imperative, no trailing period`);
    }

    const files = candidate.files;
    if (!Array.isArray(files) || files.length === 0) {
      errors.push(
        `${at}.files must be a non-empty array of repo-relative paths`,
      );
      continue;
    }
    for (const path of files) {
      if (!isFilledString(path)) {
        errors.push(`${at}.files holds a non-string path`);
      } else if ((path as string).startsWith("/")) {
        errors.push(`${at}.files holds an absolute path: ${path}`);
      }
    }
  }

  return errors;
}

/**
 * The template's type → emoji table, as code.
 *
 * An agent asked for an emoji alongside a type will sometimes return the type
 * alone — observed on the first live run of this flow. The mapping is fixed, so
 * deriving it here means no agent can drop it.
 */
const EMOJI_FOR_TYPE: Record<string, string> = {
  feat: "✨",
  fix: "🐛",
  docs: "📖",
  style: "🎨",
  refactor: "📦",
  test: "✅",
  chore: "🔧",
  remove: "🔥",
  hotfix: "🚑",
  security: "🔒",
  perf: "⚡️",
};

/** The commit's emoji: what the plan asked for, or the type's own. */
export function emojiFor(commit: Pick<CommitGroup, "emoji" | "type">): string {
  return commit.emoji?.trim() || (EMOJI_FOR_TYPE[commit.type] ?? "🔧");
}

/** The commit message, per `references/commit-template.md`. */
export function composeMessage(commit: PlannedCommit): string {
  const subject =
    `${emojiFor(commit)} ${commit.type}: ${commit.subject}`.trim();
  const body = commit.body?.trim();
  const summary = commit.summary?.trim();

  let message = subject;
  if (body) message += `\n\n${body}`;
  // The separator is only meaningful when a summary follows it.
  if (summary) message += `\n\n---\n\n${summary}`;
  return `${message}\n`;
}

/** The commit's subject: the first line of its message. */
export function subjectOf(commit: PlannedCommit): string {
  return composeMessage(commit).split("\n")[0] ?? "";
}

export type LogEntry = {
  sha: string;
  subject: string;
  /** The paths that commit changed, renames expanded to both halves. */
  paths: string[];
};

function sameFileSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const path of left) if (!right.has(path)) return false;
  return true;
}

export type Resumption = {
  /** How many of the plan's commits are already at HEAD, in order. */
  landed: number;
  /** The commit the run started from, for the coverage check. */
  base: string;
};

/**
 * How much of this plan a previous run already wrote.
 *
 * The signal is the repo, never a stored flag: the tip of the log either spells
 * out the plan's first `k` commits in reverse or it does not. That is what makes
 * a re-run after a crash finish the plan instead of duplicating its first half,
 * and it is also what keeps `base` honest — the coverage check has to diff from
 * before the *first* plan commit, not from the resumed HEAD.
 *
 * A commit counts as landed only when its subject **and** its file set match.
 * The subject alone is not identity: a repeated subject — `🔧 chore: bump the
 * version` on two consecutive runs — would otherwise read an older commit as
 * this plan's first, skip real work, and leave it uncommitted.
 *
 * `log` is newest-first. Alignment is tried longest-first so a plan whose
 * subjects repeat resolves to the longest real run rather than a short accident.
 */
export function resolveResumption(
  log: LogEntry[],
  plan: CommitPlan,
  emptyTree: string,
): Resumption {
  const subjects = plan.commits.map(subjectOf);
  const most = Math.min(log.length, subjects.length);

  for (let landed = most; landed > 0; landed--) {
    const aligned = Array.from({ length: landed }, (_, offset) => {
      const entry = log[offset];
      const commit = plan.commits[landed - 1 - offset];
      if (!entry || !commit) return false;
      return (
        entry.subject === subjects[landed - 1 - offset] &&
        sameFileSet(entry.paths, commit.files)
      );
    }).every(Boolean);
    if (aligned) {
      return { landed, base: log[landed]?.sha ?? emptyTree };
    }
  }

  return { landed: 0, base: log[0]?.sha ?? emptyTree };
}
