/**
 * The CHANGELOG entry as data. The engine gathers every in-scope commit and
 * splices the finished entry; the annalist only turns commits into sentences.
 *
 * Each bullet names the commits it covers and the rest go in `omitted`, so a
 * commit the annalist never mentioned is a validation error rather than a gap in
 * a changelog that becomes immutable once its tag is pushed.
 */

import { askJev, type JevResult } from "../../../shared/scripts/typesafe";
import { git } from "./analyze-release";
import type { Unit } from "./stages";

export const SECTIONS = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
] as const;
export type Section = (typeof SECTIONS)[number];

/** `judge` is a type the subject cannot settle — `docs` here edits skill behaviour. */
export type Suggestion = Section | "omit" | "judge";

export type Commit = {
  sha: string;
  subject: string;
  body: string;
  section: Suggestion;
  /** Set when Jev replaced a `judge` — a suggestion read from text, never the diff. */
  judgedBy?: "jev";
  confidence?: number;
};

export type UnitFacts = {
  tagName: string;
  headerLabel: string;
  commits: Commit[];
};

export type Bullet = { text: string; commits: string[] };

export type EntryDraft = {
  tagName: string;
  sections: Partial<Record<Section, Bullet[]>>;
  omitted: string[];
};

const BY_TYPE: Record<string, Suggestion> = {
  feat: "Added",
  add: "Added",
  fix: "Fixed",
  perf: "Changed",
  remove: "Removed",
  security: "Security",
  deprecate: "Deprecated",
  chore: "omit",
  test: "omit",
  release: "omit",
  ci: "omit",
  style: "omit",
};

export function sectionFor(subject: string): Suggestion {
  const type = /^(?:\S+\s+)?([a-z]+)(?:\([^)]*\))?!?:/i.exec(subject)?.[1];
  return BY_TYPE[type?.toLowerCase() ?? ""] ?? "judge";
}

const US = "\x1f";
const RS = "\x1e";

export function parseCommitLog(raw: string): Commit[] {
  return raw
    .split(RS)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim())
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split(US);
      return { sha, subject, body: body.trim(), section: sectionFor(subject) };
    });
}

export async function gatherFacts(units: Unit[]): Promise<UnitFacts[]> {
  return Promise.all(
    units.map(async (unit) => {
      const range = unit.lastTag ? [`${unit.lastTag}..HEAD`] : ["HEAD"];
      const scope = unit.pathScope ? ["--", unit.pathScope] : [];
      const raw =
        await git`git log --format=%h%x1f%s%x1f%b%x1e ${range} ${scope}`;
      return {
        tagName: unit.tagName,
        headerLabel: unit.headerLabel,
        commits: parseCommitLog(raw),
      };
    }),
  );
}

export function validateEntries(
  drafts: EntryDraft[],
  facts: UnitFacts[],
): string[] {
  const errors: string[] = [];
  const byTag = new Map(drafts.map((d) => [d.tagName, d]));

  for (const draft of drafts) {
    if (!facts.some((f) => f.tagName === draft.tagName)) {
      errors.push(`${draft.tagName}: not a unit in this release`);
    }
  }

  for (const unit of facts) {
    const draft = byTag.get(unit.tagName);
    if (!draft) {
      errors.push(`${unit.tagName}: no entry drafted`);
      continue;
    }
    const known = new Set(unit.commits.map((c) => c.sha));
    const cited = new Set(draft.omitted ?? []);
    let bullets = 0;

    for (const [name, list] of Object.entries(draft.sections ?? {})) {
      if (!(SECTIONS as readonly string[]).includes(name)) {
        errors.push(`${unit.tagName}: unknown section \`${name}\``);
        continue;
      }
      for (const bullet of list ?? []) {
        bullets += 1;
        if (!bullet.text?.trim()) {
          errors.push(`${unit.tagName}: empty bullet in ${name}`);
        }
        for (const sha of bullet.commits ?? []) {
          if (!known.has(sha)) {
            errors.push(`${unit.tagName}: bullet cites unknown commit ${sha}`);
          }
          cited.add(sha);
        }
      }
    }

    if (bullets === 0) {
      errors.push(`${unit.tagName}: entry has no bullets`);
      continue;
    }
    for (const commit of unit.commits) {
      if (!cited.has(commit.sha)) {
        errors.push(
          `${unit.tagName}: commit ${commit.sha} (${commit.subject}) is neither in a bullet nor in \`omitted\``,
        );
      }
    }
  }

  return errors;
}

export function renderEntry(
  draft: EntryDraft,
  headerLabel: string,
  date: string,
): string {
  const lines = [
    `## [${headerLabel}] - ${date}`,
    "",
    `_tracks tag \`${draft.tagName}\`_`,
  ];
  for (const section of SECTIONS) {
    const bullets = draft.sections[section];
    if (!bullets?.length) continue;
    lines.push(
      "",
      `### ${section}`,
      ...bullets.map((b) => `- ${b.text.trim()}`),
    );
  }
  return lines.join("\n");
}

const PREAMBLE = `# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`;

/** Newest-first: the blocks land above the first existing heading, which stays byte-identical. */
export function spliceEntries(changelog: string, blocks: string[]): string {
  const block = blocks.join("\n\n");
  const first = changelog.search(/^## \[/m);
  if (first !== -1) {
    return `${changelog.slice(0, first)}${block}\n\n${changelog.slice(first)}`;
  }
  const base = changelog.trim() ? changelog : PREAMBLE;
  return `${base.endsWith("\n") ? base : `${base}\n`}\n${block}\n`;
}

/** Jev caps state plus the longest question at 32k tokens; ~4 chars per token. */
const STATE_CHAR_BUDGET = 60_000;

const SECTION_CRITERIA: Record<Section | "omit", string> = {
  Added: "Gives users a capability they did not have",
  Changed: "Changes how something users already rely on behaves",
  Deprecated: "Marks something users rely on for future removal",
  Removed: "Takes away something users could use",
  Fixed: "Corrects behaviour users saw as wrong",
  Security: "Closes a vulnerability",
  omit: "No effect a user of the released software could notice",
};

export async function classifyJudged(
  facts: UnitFacts[],
  opts: { apiKey: string | undefined; fetch?: typeof fetch },
): Promise<JevResult | null> {
  const judged = facts.flatMap((unit) =>
    unit.commits.filter((commit) => commit.section === "judge"),
  );
  if (!opts.apiKey) return { skipped: "TYPESAFE_API_KEY not set" };
  if (judged.length === 0) return null;

  const bodyChars = Math.floor(STATE_CHAR_BUDGET / judged.length);
  const questions = Object.fromEntries(
    judged.map((_, i) => [
      `section:${i}`,
      {
        type: "choice" as const,
        instructions: `Which Keep a Changelog section does \`commits[${i}]\` belong in, for a reader of the release notes? A commit that edits a skill or agent prompt changes behaviour.`,
        criteria: SECTION_CRITERIA,
      },
    ]),
  );
  const result = await askJev(
    {
      state: {
        commits: judged.map((commit, index) => ({
          index,
          subject: commit.subject,
          body: commit.body.slice(0, bodyChars),
        })),
      },
      questions,
    },
    opts,
  );
  if ("answers" in result) {
    judged.forEach((commit, i) => {
      const answer = result.answers[`section:${i}`];
      commit.section = (answer?.choice ?? "judge") as Suggestion;
      commit.judgedBy = "jev";
      commit.confidence = answer?.confidence;
    });
  }
  return result;
}
