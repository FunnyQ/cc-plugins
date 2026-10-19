import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_MS } from "../../../shared/scripts/cockpit-trail";
import { applyCommit, buildNewAdrs, setLifecycle } from "./adr-commit";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function record(
  id: string,
  title = "Example decision",
  status = "Accepted",
): string {
  return `# ADR-${id}: ${title}

- Status: ${status}
- Date: 2026-09-29

## Context

Why.

## Considered alternatives

Others.

## Decision

This.

## Consequences

That.

## Evidence

- Session s1, entry e1, 2026-09-29: summary.
`;
}

const drafts = [
  {
    groupId: "g1",
    adrNumber: 27,
    entryIds: ["e1", "e2"],
    proposedPath: "docs/adr/0027-first.md",
    draftText: "first draft",
  },
  {
    groupId: "g2",
    adrNumber: 28,
    entryIds: ["e3"],
    proposedPath: "docs/adr/0028-second.md",
    draftText: "second draft",
  },
];

describe("buildNewAdrs", () => {
  test("keeps approvals in draft order and prefers the user's edit", () => {
    const result = buildNewAdrs(drafts, [
      {
        proposedPath: "docs/adr/0028-second.md",
        verdict: "approve",
        draftText: "edited",
      },
      { proposedPath: "docs/adr/0027-first.md", verdict: "approve" },
    ]);
    expect(result.newAdrs).toEqual([
      { path: "docs/adr/0027-first.md", content: "first draft" },
      { path: "docs/adr/0028-second.md", content: "edited" },
    ]);
    expect(result.drops).toBeNull();
  });

  test("turns every dropped group's entries into a watch override, so a gate-1 promote never archives to done unrecorded", () => {
    const result = buildNewAdrs(drafts, [
      { proposedPath: "docs/adr/0027-first.md", verdict: "drop" },
      { proposedPath: "docs/adr/0028-second.md", verdict: "approve" },
    ]);
    expect(result.newAdrs).toEqual([
      { path: "docs/adr/0028-second.md", content: "second draft" },
    ]);
    expect(result.drops).toEqual({
      dispositions: [{ entryIds: ["e1", "e2"], decision: "watch" }],
    });
  });

  test("returns no newAdrs when every draft was dropped", () => {
    const result = buildNewAdrs(drafts, [
      { proposedPath: "docs/adr/0027-first.md", verdict: "drop" },
      { proposedPath: "docs/adr/0028-second.md", verdict: "drop" },
    ]);
    expect(result.newAdrs).toBeNull();
  });

  test("refuses a partial, unknown, or duplicated verdict set", () => {
    expect(() =>
      buildNewAdrs(drafts, [
        { proposedPath: "docs/adr/0027-first.md", verdict: "approve" },
      ]),
    ).toThrow(/0028-second/);
    expect(() =>
      buildNewAdrs(drafts, [
        { proposedPath: "docs/adr/0027-first.md", verdict: "approve" },
        { proposedPath: "docs/adr/0028-second.md", verdict: "approve" },
        { proposedPath: "docs/adr/0099-other.md", verdict: "approve" },
      ]),
    ).toThrow(/0099-other/);
    expect(() =>
      buildNewAdrs(drafts, [
        { proposedPath: "docs/adr/0027-first.md", verdict: "approve" },
        { proposedPath: "docs/adr/0027-first.md", verdict: "drop" },
        { proposedPath: "docs/adr/0028-second.md", verdict: "approve" },
      ]),
    ).toThrow(/twice/);
  });
});

describe("setLifecycle", () => {
  test("rewrites an existing field and appends a missing one to the metadata list", () => {
    const next = setLifecycle(record("0003"), {
      Status: "Superseded",
      "Superseded by": "ADR-0027",
    });
    expect(next).toContain(
      "- Status: Superseded\n- Date: 2026-09-29\n- Superseded by: ADR-0027\n\n## Context",
    );
    expect(next).not.toContain("- Status: Accepted");
  });

  test("refuses any field outside the lifecycle set", () => {
    expect(() => setLifecycle(record("0003"), { Date: "2020-01-01" })).toThrow(
      /Date/,
    );
  });
});

async function repo(): Promise<string> {
  // Realpath because the archiver compares the plan's trailRoot with logRoot, which resolves /var to /private/var.
  const root = await realpath(await mkdtemp(join(tmpdir(), "adr-commit-")));
  tempDirs.push(root);
  await mkdir(join(root, "docs", "adr"), { recursive: true });
  await mkdir(join(root, ".cockpit", "logs"), { recursive: true });
  return root;
}

const emptyPlan = (root: string) => ({
  trailRoot: root,
  moves: [],
  refused: [],
});

describe("applyCommit", () => {
  test("writes, validates, and archives", async () => {
    const root = await repo();
    const result = await applyCommit({
      root,
      newAdrs: [{ path: "docs/adr/0001-example.md", content: record("0001") }],
      plan: emptyPlan(root),
    });
    expect(result).toEqual({
      success: true,
      newAdrPaths: ["docs/adr/0001-example.md"],
      validated: true,
      archived: true,
    });
    expect(await readFile(join(root, "docs/adr/0001-example.md"), "utf8")).toBe(
      record("0001"),
    );
  });

  test("refuses the whole batch on a collision and writes nothing, so a numbering race never half-lands a batch", async () => {
    const root = await repo();
    await writeFile(join(root, "docs/adr/0002-taken.md"), record("0002"));
    const result = await applyCommit({
      root,
      newAdrs: [
        { path: "docs/adr/0001-example.md", content: record("0001") },
        { path: "docs/adr/0002-taken.md", content: record("0002", "Other") },
      ],
      plan: emptyPlan(root),
    });
    expect(result).toEqual({
      success: false,
      reason: "path-collision",
      collisions: ["docs/adr/0002-taken.md"],
    });
    expect(existsSync(join(root, "docs/adr/0001-example.md"))).toBe(false);
  });

  test("keeps the writes but skips the irreversible archive when validation fails", async () => {
    const root = await repo();
    const from = join(root, ".cockpit", "logs", "s1.jsonl");
    const to = join(root, ".cockpit", "archive", "done", "s1.jsonl");
    await writeFile(from, "{}\n");
    const old = new Date(Date.now() - STALE_MS - 1_000);
    await utimes(from, old, old);
    const result = await applyCommit({
      root,
      newAdrs: [{ path: "docs/adr/0001-example.md", content: record("0002") }],
      plan: {
        trailRoot: root,
        moves: [{ from, to, target: "done", fromBucket: "inbox" }],
        refused: [],
      },
    });
    expect(result).toMatchObject({
      success: false,
      reason: "validation-error",
      newAdrPaths: ["docs/adr/0001-example.md"],
      archived: false,
    });
    expect(
      (result as { violations: unknown[] }).violations.length,
    ).toBeGreaterThan(0);
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
  });

  test("reports a failed metadata update without rolling back or archiving", async () => {
    const root = await repo();
    const result = await applyCommit({
      root,
      newAdrs: [{ path: "docs/adr/0001-example.md", content: record("0001") }],
      metadataUpdate: {
        path: "docs/adr/0009-missing.md",
        set: { Status: "Superseded" },
      },
      plan: emptyPlan(root),
    });
    expect(result).toMatchObject({
      success: true,
      newAdrPaths: ["docs/adr/0001-example.md"],
      metadataUpdateFailed: true,
      archived: false,
    });
    expect((result as { error: string }).error).toContain("0009-missing");
  });

  test("applies a supersession back-link", async () => {
    const root = await repo();
    await writeFile(join(root, "docs/adr/0001-old.md"), record("0001", "Old"));
    const result = await applyCommit({
      root,
      newAdrs: [
        {
          path: "docs/adr/0002-new.md",
          content: record("0002", "New").replace(
            "- Date: 2026-09-29",
            "- Date: 2026-09-29\n- Supersedes: ADR-0001",
          ),
        },
      ],
      metadataUpdate: {
        path: "docs/adr/0001-old.md",
        set: { Status: "Superseded", "Superseded by": "ADR-0002" },
      },
      plan: emptyPlan(root),
    });
    expect(result).toEqual({
      success: true,
      newAdrPaths: ["docs/adr/0002-new.md"],
      validated: true,
      archived: true,
    });
    expect(
      await readFile(join(root, "docs/adr/0001-old.md"), "utf8"),
    ).toContain("- Superseded by: ADR-0002");
  });
});
