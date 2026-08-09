import { describe, expect, test } from "bun:test";
import {
  composeMessage,
  decideShape,
  resolveResumption,
  validatePlan,
  type CommitGroup,
  type CommitPlan,
} from "./commit-plan";
import type { ParsedStatus } from "./analyze-changes";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const EMOJI: Record<string, string> = {
  feat: "✨",
  fix: "🐛",
  docs: "📖",
  chore: "🔧",
  refactor: "📦",
};

function group(
  type: string,
  files: string[],
  subject = "do a thing",
): CommitGroup {
  return { emoji: EMOJI[type] ?? "✨", type, subject, files };
}

function planOf(...commits: CommitGroup[]): CommitPlan {
  return { shape: commits.length > 1 ? "atomic" : "simple", commits };
}

function changed(...paths: string[]): ParsedStatus[] {
  return paths.map((path) => ({ path, staged: false, status: "modified" }));
}

describe("decideShape", () => {
  const two = ["feat", "feat"];

  test("simple mode forces one commit whatever the signals say", () => {
    const decision = decideShape(["feat", "fix", "docs"], {
      mode: "simple",
      totalFiles: 40,
      moduleSpread: ["x", "y", "z"],
    });
    expect(decision).toEqual({ shape: "simple", reasons: [] });
  });

  test("a single group is simple — there is nothing to split", () => {
    const decision = decideShape(["feat"], {
      mode: "auto",
      totalFiles: 20,
      moduleSpread: ["a", "b", "c"],
    });
    expect(decision.shape).toBe("simple");
  });

  test("two change types split", () => {
    const decision = decideShape(["feat", "fix"], {
      mode: "auto",
      totalFiles: 2,
      moduleSpread: ["pkg"],
    });
    expect(decision.shape).toBe("atomic");
    expect(decision.reasons[0]).toContain("2 change types");
  });

  test("one type across two modules splits", () => {
    const decision = decideShape(two, {
      mode: "auto",
      totalFiles: 2,
      moduleSpread: ["packages/chronicle", "packages/monitor"],
    });
    expect(decision.shape).toBe("atomic");
    expect(decision.reasons[0]).toContain("2 modules");
  });

  test("more than five files splits", () => {
    const decision = decideShape(two, {
      mode: "auto",
      totalFiles: 6,
      moduleSpread: ["pkg"],
    });
    expect(decision.shape).toBe("atomic");
    expect(decision.reasons[0]).toContain("6 files");
  });

  test("two cohesive groups in one module with one type stay simple", () => {
    const decision = decideShape(two, {
      mode: "auto",
      totalFiles: 5,
      moduleSpread: ["pkg"],
    });
    expect(decision).toEqual({ shape: "simple", reasons: [] });
  });

  test("every firing signal is reported", () => {
    const decision = decideShape(["feat", "fix"], {
      mode: "auto",
      totalFiles: 9,
      moduleSpread: ["x", "y"],
    });
    expect(decision.reasons).toHaveLength(3);
  });
});

describe("validatePlan", () => {
  test("accepts an exact cover", () => {
    const result = validatePlan(
      planOf(group("feat", ["a.ts", "b.ts"])),
      changed("a.ts", "b.ts"),
    );
    expect(result.ok).toBe(true);
  });

  test("reports a changed file the plan dropped", () => {
    const result = validatePlan(
      planOf(group("feat", ["a.ts"])),
      changed("a.ts", "b.ts"),
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["b.ts"]);
  });

  test("reports a file planned into two commits", () => {
    const result = validatePlan(
      planOf(group("feat", ["a.ts"]), group("fix", ["a.ts", "b.ts"])),
      changed("a.ts", "b.ts"),
    );
    expect(result.ok).toBe(false);
    expect(result.duplicated).toEqual(["a.ts"]);
  });

  test("reports a path the changeset does not hold", () => {
    const result = validatePlan(
      planOf(group("feat", ["a.ts", "ghost.ts"])),
      changed("a.ts"),
    );
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual(["ghost.ts"]);
  });

  test("allows a rename's oldPath alongside its new path", () => {
    const result = validatePlan(
      planOf(group("refactor", ["old.ts", "new.ts"])),
      [{ path: "new.ts", oldPath: "old.ts", staged: true, status: "renamed" }],
    );
    expect(result.ok).toBe(true);
  });

  test("rejects a rename that dropped its oldPath", () => {
    const result = validatePlan(planOf(group("refactor", ["new.ts"])), [
      { path: "new.ts", oldPath: "old.ts", staged: true, status: "renamed" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.splitRenames).toEqual(["old.ts -> new.ts"]);
  });

  test("rejects a rename split across two commits", () => {
    const result = validatePlan(
      planOf(group("refactor", ["new.ts"]), group("chore", ["old.ts"])),
      [{ path: "new.ts", oldPath: "old.ts", staged: true, status: "renamed" }],
    );
    expect(result.ok).toBe(false);
    expect(result.splitRenames).toEqual(["old.ts -> new.ts"]);
  });

  test("a path staged and unstaged at once needs only one assignment", () => {
    const result = validatePlan(planOf(group("feat", ["a.ts"])), [
      { path: "a.ts", staged: true, status: "modified" },
      { path: "a.ts", staged: false, status: "modified" },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("composeMessage", () => {
  test("joins subject, body, and 繁中 summary with the literal separator", () => {
    expect(
      composeMessage({
        emoji: "✨",
        type: "feat",
        subject: "add the thing",
        files: [],
        body: "- because it was needed",
        summary: "加了那個東西。",
      }),
    ).toBe(
      "✨ feat: add the thing\n\n- because it was needed\n\n---\n\n加了那個東西。\n",
    );
  });

  test("a trivial commit is subject-only, with no dangling separator", () => {
    expect(
      composeMessage({
        emoji: "🔧",
        type: "chore",
        subject: "bump to 0.2.0",
        files: [],
      }),
    ).toBe("🔧 chore: bump to 0.2.0\n");
  });

  test("a body without a summary carries no separator", () => {
    expect(
      composeMessage({
        emoji: "🐛",
        type: "fix",
        subject: "stop the crash",
        files: [],
        body: "- guard the null",
      }),
    ).toBe("🐛 fix: stop the crash\n\n- guard the null\n");
  });
});

describe("resolveResumption", () => {
  const plan = planOf(
    group("feat", ["a.ts"], "first"),
    group("fix", ["b.ts"], "second"),
    group("docs", ["c.md"], "third"),
  );
  test("a fresh run lands nothing and bases on the current tip", () => {
    const result = resolveResumption(
      [{ sha: "tip", subject: "🔧 chore: unrelated", paths: ["z.ts"] }],
      plan,
      EMPTY_TREE,
    );
    expect(result).toEqual({ landed: 0, base: "tip" });
  });

  test("an unborn branch bases on the empty tree", () => {
    expect(resolveResumption([], plan, EMPTY_TREE)).toEqual({
      landed: 0,
      base: EMPTY_TREE,
    });
  });

  test("a half-finished run resumes after its last commit and keeps the original base", () => {
    const result = resolveResumption(
      [
        { sha: "sha2", subject: "🐛 fix: second", paths: ["b.ts"] },
        { sha: "sha1", subject: "✨ feat: first", paths: ["a.ts"] },
        { sha: "before", subject: "🔧 chore: unrelated", paths: ["z.ts"] },
      ],
      plan,
      EMPTY_TREE,
    );
    expect(result).toEqual({ landed: 2, base: "before" });
  });

  test("a fully landed plan re-runs as a no-op", () => {
    const result = resolveResumption(
      [
        { sha: "sha3", subject: "📖 docs: third", paths: ["c.md"] },
        { sha: "sha2", subject: "🐛 fix: second", paths: ["b.ts"] },
        { sha: "sha1", subject: "✨ feat: first", paths: ["a.ts"] },
        { sha: "before", subject: "🔧 chore: unrelated", paths: ["z.ts"] },
      ],
      plan,
      EMPTY_TREE,
    );
    expect(result).toEqual({ landed: 3, base: "before" });
  });

  test("the log tip matching a later plan subject out of order is not a resume", () => {
    const result = resolveResumption(
      [{ sha: "tip", subject: "📖 docs: third", paths: ["c.md"] }],
      plan,
      EMPTY_TREE,
    );
    expect(result).toEqual({ landed: 0, base: "tip" });
  });

  test("a plan whose whole history is its own commits bases on the empty tree", () => {
    const result = resolveResumption(
      [
        { sha: "sha2", subject: "🐛 fix: second", paths: ["b.ts"] },
        { sha: "sha1", subject: "✨ feat: first", paths: ["a.ts"] },
      ],
      planOf(
        group("feat", ["a.ts"], "first"),
        group("fix", ["b.ts"], "second"),
      ),
      EMPTY_TREE,
    );
    expect(result).toEqual({ landed: 2, base: EMPTY_TREE });
  });

  test("subjects are matched with their emoji and type, not the bare text", () => {
    const result = resolveResumption(
      [{ sha: "sha1", subject: "first", paths: ["a.ts"] }],
      plan,
      EMPTY_TREE,
    );
    expect(result.landed).toBe(0);
  });

  test("a matching subject over a different file set is not this plan's commit", () => {
    const result = resolveResumption(
      [
        {
          sha: "older",
          subject: "✨ feat: first",
          paths: ["something-else.ts"],
        },
      ],
      plan,
      EMPTY_TREE,
    );
    expect(result).toEqual({ landed: 0, base: "older" });
  });
});
