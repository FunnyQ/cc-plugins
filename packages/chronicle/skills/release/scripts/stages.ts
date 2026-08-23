/**
 * Release stage model.
 *
 * A release is a short ordered list of stages. Each one can tell whether it has
 * already happened by looking at the repo, never at a stored flag. That is what
 * collapses `prepare` and `auto` into one plan executed to a different stage: a
 * prepare run leaves `bump` and `entry` satisfied and `commit` pending, and a
 * later `auto` picks up exactly there. Nothing has to infer "how prepared is
 * this?" — each stage answers only for itself.
 *
 * Everything here is pure. Reading files and running git belongs to the caller,
 * which hands these functions the content it read. That keeps the decisions —
 * the part that has been wrong before — under unit test.
 */

import {
  configPath,
  effectiveWorkflow,
  hasChangelogEntry,
  normalizeVersion,
  readVersionFromContent,
  versionInOutput,
  type ArtifactSpec,
  type ReleaseConfig,
  type VersionFileSpec,
} from "./analyze-release";

export type StageId =
  | "save-config"
  | "bump"
  | "artifacts"
  | "entry"
  | "commit"
  | "merge"
  | "tag"
  | "back-merge"
  | "push";

/** One releasable unit, with every name already substituted out of the config. */
export type Unit = {
  /** null for a whole-repo release. */
  component: string | null;
  targetVersion: string;
  lastTag: string | null;
  tagName: string;
  /** The changelog heading label: `chronicle 0.5.0`, or bare `0.5.0`. */
  headerLabel: string;
  /** The component dir that scopes its changelog diff; null for whole-repo. */
  pathScope: string | null;
  versionFiles: VersionFileSpec[];
  artifacts: ArtifactSpec[];
};

/** What the human settled at the version gate. Everything else is derived. */
export type VersionChoice = {
  component: string | null;
  targetVersion: string;
  lastTag: string | null;
};

/** Path → content, as read from the working tree or from HEAD. Null = unreadable. */
export type FileContents = Record<string, string | null>;

/** Artifact path → what its version command printed. Null = it could not run. */
export type ArtifactOutputs = Record<string, string | null>;

/**
 * Turn the config plus the human's choices into units. This is the whole of the
 * derivation the orchestrator used to do in prose — tag names, changelog
 * headers, path scopes — and it is pure, so it is testable.
 */
export function deriveUnits(
  config: ReleaseConfig,
  choices: VersionChoice[],
): Unit[] {
  return choices.map((choice) => {
    const version = normalizeVersion(choice.targetVersion);
    const component = choice.component;

    let versionFiles = config.versionFiles;
    let artifacts = config.artifacts ?? [];
    let pathScope: string | null = null;

    if (component !== null) {
      const spec = config.components?.find((c) => c.name === component);
      // A choice naming a component the config does not have is a caller bug.
      // Releasing "nothing" under that name would cut a tag over an empty bump.
      if (!spec) {
        throw new Error(
          `no component named ${component} in .chronicle/release.json`,
        );
      }
      versionFiles = spec.versionFiles;
      artifacts = spec.artifacts ?? [];
      pathScope = spec.path;
    }

    const tagName = config.tag
      .replaceAll("{component}", component ?? "")
      .replaceAll("{version}", version);

    return {
      component,
      targetVersion: version,
      lastTag: choice.lastTag,
      tagName,
      headerLabel: component ? `${component} ${version}` : version,
      pathScope,
      versionFiles,
      artifacts,
    };
  });
}

/** Which stages this release has at all, in execution order. */
export function stagesFor(
  config: ReleaseConfig,
  opts: { persistConfig: boolean },
): StageId[] {
  const stages: StageId[] = [];
  if (opts.persistConfig) stages.push("save-config");
  stages.push("bump");
  if (hasArtifacts(config)) stages.push("artifacts");
  stages.push("entry", "commit");
  // A missing workflow means git-flow, which owes the develop→main merge before
  // the tag and the main→develop merge after it.
  const gitFlow = effectiveWorkflow(config) === "git-flow";
  if (gitFlow) stages.push("merge");
  stages.push("tag");
  if (gitFlow) stages.push("back-merge");
  stages.push("push");
  return stages;
}

/**
 * Whether every one of the unit's version files already reads the target.
 *
 * A unit with no version file — the changelog-and-tag-only shape — is vacuously
 * done rather than permanently pending. That single line is what keeps the
 * shape from stalling the release.
 */
export function bumpDone(unit: Unit, contents: FileContents): boolean {
  const want = normalizeVersion(unit.targetVersion);
  return unit.versionFiles.every((spec) => {
    const content = contents[spec.path];
    if (content == null) return false;
    const current = readVersionFromContent(content, spec);
    return current != null && normalizeVersion(current) === want;
  });
}

/** Whether any releasable unit of this config declares a committed build output. */
export function hasArtifacts(config: ReleaseConfig): boolean {
  return (
    (config.artifacts?.length ?? 0) > 0 ||
    (config.components ?? []).some((c) => (c.artifacts?.length ?? 0) > 0)
  );
}

/**
 * Whether every declared artifact already reports the target version.
 *
 * A unit with no artifact is vacuously done, the same way `bumpDone` treats a
 * unit with no version file. An artifact whose command could not run is never
 * done: an unanswerable check is a failed check, never a passed one.
 */
export function artifactsDone(unit: Unit, outputs: ArtifactOutputs): boolean {
  return unit.artifacts.every((a) => {
    const out = outputs[a.path];
    return out != null && versionInOutput(out, unit.targetVersion);
  });
}

/** Whether the changelog already heads this unit's entry. */
export function entryDone(unit: Unit, changelog: string): boolean {
  return hasChangelogEntry(
    changelog,
    unit.targetVersion,
    unit.component ?? undefined,
  );
}

/**
 * Whether the bump and the entry are **committed**, not merely written.
 *
 * Both arguments come from HEAD, never from the working tree. That distinction
 * is the whole point: a stopped `prepare` run leaves the working tree carrying
 * both halves while HEAD carries neither, and tagging there would produce a tag
 * whose commit does not contain the version it names.
 */
export function commitDone(
  unit: Unit,
  headContents: FileContents,
  headChangelog: string,
): boolean {
  return bumpDone(unit, headContents) && entryDone(unit, headChangelog);
}

export type TagState = "missing" | "correct" | "conflict";

/**
 * `correct` makes a re-run idempotent; `conflict` is the refusal to move a tag
 * that already points somewhere else. Never resolve a conflict by retagging.
 */
export function tagState(
  unit: Unit,
  tagTargets: Record<string, string>,
  releaseCommit: string,
): TagState {
  const target = tagTargets[unit.tagName];
  if (target == null) return "missing";
  return target === releaseCommit ? "correct" : "conflict";
}

/**
 * Every file the release commit stages, in a stable order.
 *
 * Deliberately independent of which run wrote them. Working out "whose files has
 * nobody named yet?" is what previously produced an empty commit; the release's
 * files are the release's files whether this run bumped them or an earlier
 * prepare run did. `git add` on an unchanged path is a no-op, and a run where
 * every path is unchanged never reaches here because `commitDone` is already true.
 */
export function touchedFiles(
  units: Unit[],
  config: ReleaseConfig,
  opts: { persistConfig: boolean },
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const unit of units) {
    for (const spec of unit.versionFiles) add(spec.path);
    for (const artifact of unit.artifacts) add(artifact.path);
  }
  add(config.changelog);
  if (opts.persistConfig) add(configPath(""));
  return out;
}
