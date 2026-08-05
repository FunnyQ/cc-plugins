import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_MS } from "../../../shared/scripts/cockpit-trail";
import type { ArchivePlan, Move } from "./archive-plan";
import { applyArchive, validatePlan } from "./archive-logs";

type Fixture = {
  root: string;
  logs: string;
  cleanup: () => void;
};

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archive-logs-")));
  const logs = join(root, ".cockpit", "logs");
  mkdirSync(logs, { recursive: true });
  return {
    root,
    logs,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function move(
  root: string,
  sessionId: string,
  target: "done" | "watch" = "done",
): Move {
  return {
    from: join(root, ".cockpit", "logs", `${sessionId}.jsonl`),
    to: join(root, ".cockpit", "archive", target, `${sessionId}.jsonl`),
    target,
    fromBucket: "inbox",
  };
}

function plan(root: string, moves: Move[]): ArchivePlan {
  return { trailRoot: root, moves, refused: [] };
}

function stale(path: string, contents = "fixture\n"): void {
  writeFileSync(path, contents);
  const date = new Date(Date.now() - STALE_MS - 1_000);
  utimesSync(path, date, date);
}

async function expectStructuralRejection(
  fixtureValue: Fixture,
  archivePlan: ArchivePlan,
  source?: string,
): Promise<void> {
  const archive = join(fixtureValue.root, ".cockpit", "archive");
  const existedBefore = existsSync(archive);
  await expect(applyArchive(archivePlan, fixtureValue.root)).rejects.toThrow();
  expect(existsSync(archive)).toBe(existedBefore);
  if (source) expect(existsSync(source)).toBe(true);
}

describe("validatePlan", () => {
  test("rejects a source rewritten to escape the trail without touching files", async () => {
    const item = fixture();
    try {
      const source = join(item.logs, "escape.jsonl");
      stale(source);
      const tampered = move(item.root, "escape");
      tampered.from = join(item.logs, "..", "..", "..", "etc", "passwd");

      expect(validatePlan(plan(item.root, [tampered]), item.root)).not.toEqual([]);
      await expectStructuralRejection(item, plan(item.root, [tampered]), source);
    } finally {
      item.cleanup();
    }
  });

  test("rejects a destination outside the archive", async () => {
    const item = fixture();
    try {
      const source = join(item.logs, "outside.jsonl");
      stale(source);
      const tampered = move(item.root, "outside");
      tampered.to = join(item.root, "outside.jsonl");
      await expectStructuralRejection(item, plan(item.root, [tampered]), source);
    } finally {
      item.cleanup();
    }
  });

  test("rejects done as a source bucket", async () => {
    const item = fixture();
    try {
      const source = join(item.logs, "terminal.jsonl");
      stale(source);
      const tampered = move(item.root, "terminal");
      tampered.fromBucket = "done" as Move["fromBucket"];
      await expectStructuralRejection(item, plan(item.root, [tampered]), source);
    } finally {
      item.cleanup();
    }
  });

  test("rejects a target that disagrees with the allowed transition", async () => {
    const item = fixture();
    try {
      const watch = join(item.root, ".cockpit", "archive", "watch");
      mkdirSync(watch, { recursive: true });
      const source = join(watch, "wrong-target.jsonl");
      stale(source);
      const tampered: Move = {
        from: source,
        to: join(item.root, ".cockpit", "archive", "inbox", "wrong-target.jsonl"),
        fromBucket: "watch",
        target: "inbox" as Move["target"],
      };

      await expectStructuralRejection(item, plan(item.root, [tampered]), source);
    } finally {
      item.cleanup();
    }
  });

  for (const ancestor of ["cockpit", "archive", "bucket"] as const) {
    test(`rejects a symlinked ${ancestor} destination ancestor`, async () => {
      const item = fixture();
      const targetRoot = realpathSync(
        mkdtempSync(join(tmpdir(), "archive-target-")),
      );
      try {
        let source: string;
        if (ancestor === "cockpit") {
          rmSync(join(item.root, ".cockpit"), { recursive: true });
          symlinkSync(targetRoot, join(item.root, ".cockpit"));
          mkdirSync(join(targetRoot, "logs"));
          source = join(targetRoot, "logs", "linked.jsonl");
        } else {
          source = join(item.logs, "linked.jsonl");
          if (ancestor === "archive") {
            symlinkSync(targetRoot, join(item.root, ".cockpit", "archive"));
          } else {
            mkdirSync(join(item.root, ".cockpit", "archive"));
            symlinkSync(targetRoot, join(item.root, ".cockpit", "archive", "done"));
          }
        }
        stale(source);
        const archivePlan = plan(item.root, [move(item.root, "linked")]);

        expect(validatePlan(archivePlan, item.root).join("\n")).toContain("symlink");
        await expect(applyArchive(archivePlan, item.root)).rejects.toThrow("symlink");
        expect(existsSync(source)).toBe(true);
      } finally {
        item.cleanup();
        rmSync(targetRoot, { recursive: true, force: true });
      }
    });
  }
});

describe("applyArchive", () => {
  test("skips a source that becomes live while moving the remaining stale file", async () => {
    const item = fixture();
    try {
      const liveMove = move(item.root, "live");
      const staleMove = move(item.root, "stale");
      stale(liveMove.from);
      stale(staleMove.from, "preserved bytes\n");
      const archivePlan = plan(item.root, [liveMove, staleMove]);
      const now = new Date();
      utimesSync(liveMove.from, now, now);

      const result = await applyArchive(archivePlan, item.root);

      expect(result).toEqual({
        moved: [staleMove],
        failed: [expect.objectContaining({ sessionId: "live", reason: "live" })],
      });
      expect(existsSync(liveMove.from)).toBe(true);
      expect(readFileSync(staleMove.to, "utf8")).toBe("preserved bytes\n");
    } finally {
      item.cleanup();
    }
  });

  test("reports a source deleted between plan and apply as missing", async () => {
    const item = fixture();
    try {
      const missingMove = move(item.root, "missing");
      stale(missingMove.from);
      const archivePlan = plan(item.root, [missingMove]);
      unlinkSync(missingMove.from);

      expect(await applyArchive(archivePlan, item.root)).toEqual({
        moved: [],
        failed: [expect.objectContaining({ reason: "missing" })],
      });
    } finally {
      item.cleanup();
    }
  });

  test("reports a source symlink as a collision", async () => {
    const item = fixture();
    try {
      const linkedMove = move(item.root, "linked-source");
      const target = join(item.root, "target.jsonl");
      stale(target);
      symlinkSync(target, linkedMove.from);

      const result = await applyArchive(plan(item.root, [linkedMove]), item.root);

      expect(result).toEqual({
        moved: [],
        failed: [expect.objectContaining({ reason: "collision" })],
      });
      expect(existsSync(target)).toBe(true);
    } finally {
      item.cleanup();
    }
  });

  test("reports an existing destination as a collision", async () => {
    const item = fixture();
    try {
      const collidingMove = move(item.root, "existing");
      stale(collidingMove.from);
      mkdirSync(join(item.root, ".cockpit", "archive", "done"), {
        recursive: true,
      });
      writeFileSync(collidingMove.to, "existing destination\n");

      const result = await applyArchive(
        plan(item.root, [collidingMove]),
        item.root,
      );

      expect(result.failed[0]).toEqual(
        expect.objectContaining({ reason: "collision" }),
      );
      expect(existsSync(collidingMove.from)).toBe(true);
      expect(readFileSync(collidingMove.to, "utf8")).toBe(
        "existing destination\n",
      );
    } finally {
      item.cleanup();
    }
  });

  test("rejects a plan for a different trail root", async () => {
    const item = fixture();
    try {
      const source = join(item.logs, "root.jsonl");
      stale(source);
      const archivePlan = plan("/test-trail", [move(item.root, "root")]);
      await expectStructuralRejection(item, archivePlan, source);
    } finally {
      item.cleanup();
    }
  });

  test("rejects both moves sharing a destination as collisions before touching either", async () => {
    const item = fixture();
    try {
      const duplicate = move(item.root, "duplicate");
      stale(duplicate.from);

      const result = await applyArchive(
        plan(item.root, [duplicate, { ...duplicate }]),
        item.root,
      );

      expect(result.moved).toEqual([]);
      expect(result.failed.map(({ reason }) => reason)).toEqual([
        "collision",
        "collision",
      ]);
      expect(existsSync(duplicate.from)).toBe(true);
      expect(existsSync(join(item.root, ".cockpit", "archive"))).toBe(false);
    } finally {
      item.cleanup();
    }
  });

  test("creates archive directories only for at least one eligible move", async () => {
    const empty = fixture();
    const movable = fixture();
    try {
      expect(await applyArchive(plan(empty.root, []), empty.root)).toEqual({
        moved: [],
        failed: [],
      });
      expect(existsSync(join(empty.root, ".cockpit", "archive"))).toBe(false);

      const eligible = move(movable.root, "eligible");
      stale(eligible.from);
      await applyArchive(plan(movable.root, [eligible]), movable.root);
      expect(
        lstatSync(
          join(movable.root, ".cockpit", "archive", "done"),
        ).isDirectory(),
      ).toBe(true);
    } finally {
      empty.cleanup();
      movable.cleanup();
    }
  });

  test("moves a stale log byte-identically and leaves a fresh log in inbox", async () => {
    const item = fixture();
    try {
      const oldMove = move(item.root, "old");
      const freshMove = move(item.root, "fresh");
      stale(oldMove.from, "{\"decision\":\"kept\"}\n");
      writeFileSync(freshMove.from, "fresh\n");

      const result = await applyArchive(plan(item.root, [oldMove, freshMove]), item.root);

      expect(result.moved).toHaveLength(1);
      expect(result.failed[0]).toEqual(
        expect.objectContaining({ sessionId: "fresh", reason: "live" }),
      );
      expect(readFileSync(oldMove.to, "utf8")).toBe("{\"decision\":\"kept\"}\n");
      expect(existsSync(oldMove.from)).toBe(false);
      expect(existsSync(freshMove.from)).toBe(true);
    } finally {
      item.cleanup();
    }
  });
});
