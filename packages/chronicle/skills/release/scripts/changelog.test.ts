import { describe, expect, test } from "bun:test";

import {
  parseCommitLog,
  renderEntry,
  sectionFor,
  spliceEntries,
  validateEntries,
  type EntryDraft,
  type UnitFacts,
} from "./changelog";

const US = "\x1f";
const RS = "\x1e";

describe("parseCommitLog", () => {
  test("splits records and fields, keeping multi-line bodies", () => {
    const raw = `abc1234${US}✨ feat: Add x${US}line one\nline two${RS}\ndef5678${US}🐛 fix: Fix y${US}${RS}\n`;
    expect(parseCommitLog(raw)).toEqual([
      {
        sha: "abc1234",
        subject: "✨ feat: Add x",
        body: "line one\nline two",
        section: "Added",
      },
      { sha: "def5678", subject: "🐛 fix: Fix y", body: "", section: "Fixed" },
    ]);
  });

  test("returns nothing for empty output", () => {
    expect(parseCommitLog("")).toEqual([]);
  });
});

describe("sectionFor", () => {
  test.each([
    ["✨ feat: Add a thing", "Added"],
    ["feat(scope): Add a thing", "Added"],
    ["➕ add: New file", "Added"],
    ["🐛 fix: Crash on load", "Fixed"],
    ["⚡ perf: Faster", "Changed"],
    ["🔥 remove: Old flag", "Removed"],
    ["🔧 chore: Bump deps", "omit"],
    ["✅ test: Cover x", "omit"],
    ["🔧 release: chronicle 0.1.0", "omit"],
    ["📖 docs: Reword skill", "judge"],
    ["♻️ refactor: Split module", "judge"],
    ["Merge branch 'x'", "judge"],
  ])("%s → %s", (subject, section) => {
    expect(sectionFor(subject)).toBe(section as ReturnType<typeof sectionFor>);
  });
});

const facts: UnitFacts[] = [
  {
    tagName: "chronicle-v0.2.0",
    headerLabel: "chronicle 0.2.0",
    commits: [
      { sha: "a1", subject: "✨ feat: A", body: "", section: "Added" },
      { sha: "b2", subject: "🐛 fix: B", body: "", section: "Fixed" },
      { sha: "c3", subject: "🔧 chore: C", body: "", section: "omit" },
    ],
  },
];

const good: EntryDraft[] = [
  {
    tagName: "chronicle-v0.2.0",
    sections: {
      Added: [{ text: "You can now A.", commits: ["a1"] }],
      Fixed: [{ text: "B no longer crashes.", commits: ["b2"] }],
    },
    omitted: ["c3"],
  },
];

describe("validateEntries", () => {
  test("accepts a draft that accounts for every commit", () => {
    expect(validateEntries(good, facts)).toEqual([]);
  });

  test("names a commit the draft never accounted for", () => {
    const draft: EntryDraft[] = [
      { ...good[0]!, sections: { Added: good[0]!.sections.Added! } },
    ];
    expect(validateEntries(draft, facts)).toEqual([
      "chronicle-v0.2.0: commit b2 (🐛 fix: B) is neither in a bullet nor in `omitted`",
    ]);
  });

  test("rejects an unknown section, an unknown sha, and a missing unit", () => {
    const draft = [
      {
        tagName: "chronicle-v0.2.0",
        sections: {
          Improved: [{ text: "x", commits: [] }],
          Added: [{ text: "y", commits: ["zz"] }],
        },
        omitted: ["a1", "b2", "c3"],
      },
    ] as unknown as EntryDraft[];
    const errors = validateEntries(draft, [
      ...facts,
      { tagName: "monitor-v1.0.0", headerLabel: "monitor 1.0.0", commits: [] },
    ]);
    expect(errors).toContain("chronicle-v0.2.0: unknown section `Improved`");
    expect(errors).toContain(
      "chronicle-v0.2.0: bullet cites unknown commit zz",
    );
    expect(errors).toContain("monitor-v1.0.0: no entry drafted");
  });

  test("rejects an entry with no bullets", () => {
    const draft: EntryDraft[] = [
      {
        tagName: "chronicle-v0.2.0",
        sections: {},
        omitted: ["a1", "b2", "c3"],
      },
    ];
    expect(validateEntries(draft, facts)).toEqual([
      "chronicle-v0.2.0: entry has no bullets",
    ]);
  });
});

describe("renderEntry", () => {
  test("renders sections in Keep a Changelog order with the tag line", () => {
    const draft: EntryDraft = {
      tagName: "chronicle-v0.2.0",
      sections: {
        Fixed: [{ text: "B no longer crashes.", commits: ["b2"] }],
        Added: [{ text: "You can now A.", commits: ["a1"] }],
      },
      omitted: [],
    };
    expect(renderEntry(draft, "chronicle 0.2.0", "2026-09-29")).toBe(
      [
        "## [chronicle 0.2.0] - 2026-09-29",
        "",
        "_tracks tag `chronicle-v0.2.0`_",
        "",
        "### Added",
        "- You can now A.",
        "",
        "### Fixed",
        "- B no longer crashes.",
      ].join("\n"),
    );
  });
});

describe("spliceEntries", () => {
  const preamble = "# Changelog\n\nIntro.\n";

  test("inserts above the first heading and leaves it untouched", () => {
    const file = `${preamble}\n## [monitor 3.0.0] - 2026-01-01\n\n- old\n`;
    expect(spliceEntries(file, ["## [chronicle 0.2.0] - x\n\n- new"])).toBe(
      `${preamble}\n## [chronicle 0.2.0] - x\n\n- new\n\n## [monitor 3.0.0] - 2026-01-01\n\n- old\n`,
    );
  });

  test("appends after the preamble when there is no heading yet", () => {
    expect(spliceEntries(preamble, ["## [0.1.0] - x"])).toBe(
      `${preamble}\n## [0.1.0] - x\n`,
    );
  });

  test("creates the Keep a Changelog preamble for a missing file", () => {
    const out = spliceEntries("", ["## [0.1.0] - x"]);
    expect(out.startsWith("# Changelog\n")).toBe(true);
    expect(out).toContain("keepachangelog.com");
    expect(out.endsWith("## [0.1.0] - x\n")).toBe(true);
  });

  test("joins several blocks newest-first in the order given", () => {
    const out = spliceEntries(`${preamble}\n## [old] - y\n`, [
      "## [a]",
      "## [b]",
    ]);
    expect(out).toBe(`${preamble}\n## [a]\n\n## [b]\n\n## [old] - y\n`);
  });
});
