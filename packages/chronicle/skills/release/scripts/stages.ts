/**
 * Release stage model.
 *
 * A release is a short ordered list of stages. Each one can tell whether it has
 * already happened by looking at the repo, never at a stored flag. That is what
 * collapses `prepare` and `auto` into one plan executed to a different stage: a
 * prepare run leaves `bump` and `entry` satisfied and `commit` pending, and a
 * later `auto` picks up exactly there. Nothing has to infer "how prepared is
 * this?" — each stage answers only for itself.
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

export type Unit = {
  component: string | null;
  targetVersion: string;
  lastTag: string | null;
  tagName: string;
  headerLabel: string;
  pathScope: string | null;
  versionFiles: VersionFileSpec[];
  artifacts: ArtifactSpec[];
};

export type VersionChoice = {
  component: string | null;
  targetVersion: string;
  lastTag: string | null;
};

export type FileContents = Record<string, string | null>;

export type ArtifactOutputs = Record<string, string | null>;

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

export function stagesFor(
  config: ReleaseConfig,
  opts: { persistConfig: boolean },
): StageId[] {
  const stages: StageId[] = [];
  if (opts.persistConfig) stages.push("save-config");
  stages.push("bump");
  if (hasArtifacts(config)) stages.push("artifacts");
  stages.push("entry", "commit");
  const gitFlow = effectiveWorkflow(config) === "git-flow";
  if (gitFlow) stages.push("merge");
  stages.push("tag");
  if (gitFlow) stages.push("back-merge");
  stages.push("push");
  return stages;
}

export function bumpDone(unit: Unit, contents: FileContents): boolean {
  const want = normalizeVersion(unit.targetVersion);
  return unit.versionFiles.every((spec) => {
    const content = contents[spec.path];
    if (content == null) return false;
    const current = readVersionFromContent(content, spec);
    return current != null && normalizeVersion(current) === want;
  });
}

export function hasArtifacts(config: ReleaseConfig): boolean {
  return (
    (config.artifacts?.length ?? 0) > 0 ||
    (config.components ?? []).some((c) => (c.artifacts?.length ?? 0) > 0)
  );
}

export function artifactsDone(unit: Unit, outputs: ArtifactOutputs): boolean {
  return unit.artifacts.every((a) => {
    const out = outputs[a.path];
    return out != null && versionInOutput(out, unit.targetVersion);
  });
}

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
