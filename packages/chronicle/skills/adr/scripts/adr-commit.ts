#!/usr/bin/env bun
/**
 * The ADR write side, as code. `verdicts` folds gate 2's reply into the records to
 * write and the watch overrides for dropped groups; `apply` checks for collisions,
 * writes, applies the lifecycle link, validates, and archives. Draft text travels
 * between them as files, so no model retypes a record it already wrote once.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { logRoot } from "../../../shared/scripts/cockpit-trail";
import { validateDir, type Violation } from "./adr-validate";
import { applyArchive } from "./archive-logs";
import type { ArchivePlan } from "./archive-plan";
import type { Gate2Draft } from "./gate-page";
import type { Override } from "./triage";

export type Draft = Gate2Draft & { entryIds: string[] };
export type Verdict = {
  proposedPath: string;
  verdict: "approve" | "drop";
  draftText?: string;
};
export type NewAdr = { path: string; content: string };
export type MetadataUpdate = { path: string; set: Record<string, string> };

export type CommitResult =
  | {
      success: true;
      newAdrPaths: string[];
      validated: true;
      archived: true;
      archiveSkipped?: string[];
    }
  | { success: false; reason: "path-collision"; collisions: string[] }
  | {
      success: false;
      reason: "validation-error";
      newAdrPaths: string[];
      violations: Violation[];
      archived: false;
    }
  | {
      success: true;
      newAdrPaths: string[];
      metadataUpdateFailed: true;
      error: string;
      archived: false;
    };

const LIFECYCLE_FIELDS = [
  "Status",
  "Supersedes",
  "Superseded by",
  "Deprecated",
];

export function buildNewAdrs(
  drafts: Draft[],
  verdicts: Verdict[],
): { newAdrs: NewAdr[] | null; drops: Override | null } {
  const byPath = new Map<string, Verdict>();
  for (const verdict of verdicts) {
    if (!drafts.some((draft) => draft.proposedPath === verdict.proposedPath)) {
      throw new Error(`Verdict for an unknown draft: ${verdict.proposedPath}`);
    }
    if (byPath.has(verdict.proposedPath)) {
      throw new Error(`Verdict given twice: ${verdict.proposedPath}`);
    }
    byPath.set(verdict.proposedPath, verdict);
  }
  const missing = drafts.filter((draft) => !byPath.has(draft.proposedPath));
  if (missing.length > 0) {
    throw new Error(
      `Partial reply, no verdict for: ${missing.map((draft) => draft.proposedPath).join(", ")}`,
    );
  }

  const newAdrs: NewAdr[] = [];
  const dropped: Draft[] = [];
  for (const draft of drafts) {
    const verdict = byPath.get(draft.proposedPath)!;
    if (verdict.verdict === "drop") {
      dropped.push(draft);
      continue;
    }
    newAdrs.push({
      path: draft.proposedPath,
      content: verdict.draftText ?? draft.draftText,
    });
  }

  return {
    newAdrs: newAdrs.length > 0 ? newAdrs : null,
    drops:
      dropped.length > 0
        ? {
            dispositions: dropped.map((draft) => ({
              entryIds: draft.entryIds,
              decision: "watch",
            })),
          }
        : null,
  };
}

export function setLifecycle(
  content: string,
  set: Record<string, string>,
): string {
  const lines = content.split("\n");
  const firstSection = lines.findIndex((line) => line.startsWith("## "));
  const headerEnd = firstSection === -1 ? lines.length : firstSection;
  let lastMeta = lines
    .slice(0, headerEnd)
    .findLastIndex((line) => line.startsWith("- "));
  if (lastMeta === -1) throw new Error("Record has no metadata list.");

  for (const [field, value] of Object.entries(set)) {
    if (!LIFECYCLE_FIELDS.includes(field)) {
      throw new Error(
        `Refusing to set ${field}: only ${LIFECYCLE_FIELDS.join(", ")} are lifecycle fields.`,
      );
    }
    const prefix = `- ${field}:`;
    const index = lines
      .slice(0, headerEnd)
      .findIndex((line) => line.startsWith(prefix));
    if (index !== -1) {
      lines[index] = `${prefix} ${value}`;
    } else {
      lastMeta += 1;
      lines.splice(lastMeta, 0, `${prefix} ${value}`);
    }
  }
  return lines.join("\n");
}

export async function applyCommit(input: {
  root: string;
  newAdrs?: NewAdr[];
  metadataUpdate?: MetadataUpdate;
  plan: ArchivePlan;
  adrDir?: string;
}): Promise<CommitResult> {
  const at = (path: string) => resolve(input.root, path);
  const newAdrs = input.newAdrs ?? [];

  // Checked before any write: a batch that half-lands and then refuses leaves the caller
  // unable to tell which records exist, and a collision is a numbering race, not repairable.
  const collisions = newAdrs
    .filter((adr) => existsSync(at(adr.path)))
    .map((adr) => adr.path);
  if (collisions.length > 0) {
    return { success: false, reason: "path-collision", collisions };
  }

  for (const adr of newAdrs) {
    await mkdir(dirname(at(adr.path)), { recursive: true });
    await writeFile(at(adr.path), adr.content);
  }
  const newAdrPaths = newAdrs.map((adr) => adr.path);

  if (input.metadataUpdate) {
    const target = input.metadataUpdate.path;
    try {
      const current = await readFile(at(target), "utf8");
      await writeFile(
        at(target),
        setLifecycle(current, input.metadataUpdate.set),
      );
    } catch (error) {
      return {
        success: true,
        newAdrPaths,
        metadataUpdateFailed: true,
        error: `metadata update failed for ${target}: ${error instanceof Error ? error.message : String(error)}`,
        archived: false,
      };
    }
  }

  // Validation gates the archive because archiving is the one irreversible step.
  const validation = await validateDir(at(input.adrDir ?? "docs/adr"));
  const errors = validation.violations.filter(
    (violation) => violation.severity === "error",
  );
  if (errors.length > 0) {
    return {
      success: false,
      reason: "validation-error",
      newAdrPaths,
      violations: errors,
      archived: false,
    };
  }

  const archive = await applyArchive(input.plan, logRoot(input.root));
  const skipped = archive.failed.map(
    (item) => `${item.sessionId}: ${item.reason}: ${item.detail}`,
  );
  return {
    success: true,
    newAdrPaths,
    validated: true,
    archived: true,
    ...(skipped.length > 0 ? { archiveSkipped: skipped } : {}),
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function required(argv: string[], name: string): string {
  const value = flag(argv, name);
  if (!value) throw new Error(`Missing ${name} <path>.`);
  return value;
}

async function verdictsCommand(argv: string[]): Promise<void> {
  const runDir = required(argv, "--run");
  const payload = await readJson<{ drafts: Draft[] }>(
    join(runDir, "gate2.json"),
  );
  const response = await readJson<{ verdicts: Verdict[] }>(
    flag(argv, "--response") ?? join(runDir, "gate2.html.response.json"),
  );
  const { newAdrs, drops } = buildNewAdrs(payload.drafts, response.verdicts);

  const newAdrsPath = join(runDir, "new-adrs.json");
  const dropsPath = join(runDir, "gate2-drops.json");
  if (newAdrs)
    await writeFile(newAdrsPath, `${JSON.stringify(newAdrs, null, 2)}\n`);
  if (drops) await writeFile(dropsPath, `${JSON.stringify(drops, null, 2)}\n`);
  console.log(
    JSON.stringify({
      approved: newAdrs?.length ?? 0,
      dropped: drops?.dispositions?.length ?? 0,
      newAdrsPath: newAdrs ? newAdrsPath : null,
      dropsPath: drops ? dropsPath : null,
    }),
  );
}

async function applyCommand(argv: string[]): Promise<void> {
  const newAdrsPath = flag(argv, "--new-adrs");
  const metadataPath = flag(argv, "--metadata");
  const result = await applyCommit({
    root: process.cwd(),
    newAdrs: newAdrsPath ? await readJson<NewAdr[]>(newAdrsPath) : undefined,
    metadataUpdate: metadataPath
      ? await readJson<MetadataUpdate>(metadataPath)
      : undefined,
    plan: await readJson<ArchivePlan>(required(argv, "--plan")),
  });
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  const [command, ...rest] = Bun.argv.slice(2);
  const commands: Record<string, (argv: string[]) => Promise<void>> = {
    verdicts: verdictsCommand,
    apply: applyCommand,
  };
  const run = command ? commands[command] : undefined;
  if (!run) {
    console.error(
      [
        "Usage:",
        "  bun adr-commit.ts verdicts --run <runDir> [--response <file>]",
        "  bun adr-commit.ts apply --plan <plan.json> [--new-adrs <file>] [--metadata <file>]",
      ].join("\n"),
    );
    process.exit(2);
  }
  run(rest).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
