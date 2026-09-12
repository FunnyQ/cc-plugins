import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_MS } from "../../../shared/scripts/cockpit-trail";
import type {
  AdrContext,
  EntrySkeleton,
  SessionFile,
} from "./collect-adr-context";
import {
  buildTriage,
  fallbackResult,
  mergeTriage,
  planBatches,
  validateJudgment,
  type Batch,
  type BatchResult,
  type RunMeta,
} from "./triage";

const NOW = 10 * STALE_MS;
const OLD = NOW - STALE_MS;

function session(
  sessionId: string,
  bucket: SessionFile["bucket"],
  mtimeMs = OLD,
): SessionFile {
  return {
    sessionId,
    path: `/trail/${bucket}/${sessionId}.jsonl`,
    bucket,
    mtimeMs,
    entryCount: 0,
  };
}

function skeleton(
  id: string,
  sessionId: string,
  decision: string,
  kind: EntrySkeleton["kind"] = "decision",
): EntrySkeleton {
  return {
    id,
    sessionId,
    kind,
    decision,
    timestamp: "2026-09-10T00:00:00Z",
    files: [`${id}.ts`],
  };
}

function context(
  sessions: SessionFile[],
  skeletons: EntrySkeleton[],
): AdrContext {
  return {
    trailRoot: "/trail",
    hasTrail: true,
    sessions,
    skeletons,
    adrDir: "/trail/docs/adr",
  };
}

describe("buildTriage", () => {
  test("clusters entries that share a decision across sessions", () => {
    const triage = buildTriage(
      context(
        [session("s1", "inbox"), session("s2", "inbox")],
        [
          skeleton("a", "s1", "Ship a Status field"),
          skeleton("b", "s2", "Ship a Status field", "caveat"),
          skeleton("c", "s2", "Other"),
        ],
      ),
      NOW,
    );

    expect(
      triage.clusters.map((cluster) => [
        cluster.clusterId,
        cluster.entryIds,
        cluster.sessionIds,
      ]),
    ).toEqual([
      ["c1", ["a", "b"], ["s1", "s2"]],
      ["c2", ["c"], ["s2"]],
    ]);
    expect(triage.clusters[0]?.kinds).toEqual(["decision", "caveat"]);
    expect(triage.assignments).toEqual([
      { sessionId: "s1", target: "done", from: "inbox" },
      { sessionId: "s2", target: "done", from: "inbox" },
    ]);
  });

  test("leaves a fresh inbox session out and counts it", () => {
    const triage = buildTriage(
      context(
        [session("old", "inbox"), session("fresh", "inbox", NOW - 1_000)],
        [skeleton("a", "old", "A"), skeleton("b", "fresh", "B")],
      ),
      NOW,
    );

    expect(triage.clusters.map(({ decision }) => decision)).toEqual(["A"]);
    expect(triage.assignments.map(({ sessionId }) => sessionId)).toEqual([
      "old",
    ]);
    expect(triage.tooFresh).toBe(1);
  });

  test("pulls a watched session back only when it shares a decision with the inbox", () => {
    const triage = buildTriage(
      context(
        [
          session("trigger", "inbox"),
          session("woken", "watch"),
          session("asleep", "watch"),
        ],
        [
          skeleton("t", "trigger", "Cache keys"),
          skeleton("w1", "woken", "Cache keys"),
          skeleton("w2", "woken", "Side note"),
          skeleton("q", "asleep", "Quiet"),
        ],
      ),
      NOW,
    );

    expect(
      triage.clusters.map((cluster) => [
        cluster.decision,
        cluster.entryIds,
        cluster.watched,
      ]),
    ).toEqual([
      ["Cache keys", ["t", "w1"], true],
      ["Side note", ["w2"], true],
    ]);
    expect(triage.assignments).toEqual([
      { sessionId: "trigger", target: "done", from: "inbox" },
      { sessionId: "woken", target: "done", from: "watch" },
    ]);
  });

  test("adds done entries as evidence without assigning their sessions", () => {
    const triage = buildTriage(
      context(
        [session("s1", "inbox"), session("old", "done")],
        [
          skeleton("a", "s1", "A"),
          skeleton("d", "old", "A"),
          skeleton("e", "old", "Archived only"),
        ],
      ),
      NOW,
    );

    expect(
      triage.clusters.map((cluster) => [cluster.decision, cluster.entryIds]),
    ).toEqual([
      ["A", ["a", "d"]],
      ["Archived only", ["e"]],
    ]);
    expect(triage.assignments.map(({ sessionId }) => sessionId)).toEqual([
      "s1",
    ]);
  });

  test("evidence mode clusters every session in every bucket and assigns none", () => {
    const triage = buildTriage(
      context(
        [
          session("fresh", "inbox", NOW - 1_000),
          session("asleep", "watch"),
          session("old", "done"),
        ],
        [
          skeleton("f", "fresh", "F"),
          skeleton("q", "asleep", "Q"),
          skeleton("d", "old", "D"),
        ],
      ),
      NOW,
      { evidence: true },
    );

    expect(
      triage.clusters.map((cluster) => [cluster.decision, cluster.watched]),
    ).toEqual([
      ["F", false],
      ["Q", true],
      ["D", false],
    ]);
    expect(triage.assignments).toEqual([]);
  });
});

describe("planBatches", () => {
  const cases: [number, number[]][] = [
    [0, []],
    [5, [5]],
    [8, [8]],
    [9, [5, 4]],
    [101, [11, 11, 11, 11, 11, 11, 11, 11, 11, 2]],
  ];

  for (const [count, sizes] of cases) {
    test(`${count} clusters split into ${sizes.length} batches`, () => {
      const items = Array.from({ length: count }, (_, index) => index);
      const batches = planBatches(items);

      expect(batches.map((batch) => batch.length)).toEqual(sizes);
      expect(batches.flat()).toEqual(items);
    });
  }
});

const batch: Batch = {
  batch: 1,
  adrs: [{ id: "ADR-0001", title: "Centralize auth", status: "Accepted" }],
  clusters: [
    {
      clusterId: "c1",
      decision: "A",
      entryIds: ["a1", "a2"],
      sessionIds: ["s1"],
      kinds: ["decision"],
      files: [],
      watched: false,
    },
    {
      clusterId: "c2",
      decision: "B",
      entryIds: ["b1"],
      sessionIds: ["s2"],
      kinds: ["caveat"],
      files: [],
      watched: false,
    },
  ],
};

function judgment(
  candidates: Record<string, unknown>[] = [
    {
      clusterId: "c1",
      title: "A",
      disposition: "watch",
      reason: "close read",
      matchesAdr: null,
    },
    {
      clusterId: "c2",
      title: "B",
      disposition: "skip",
      reason: "Matches ADR-0001",
      matchesAdr: "ADR-0001",
    },
  ],
  conflicts: Record<string, unknown>[] = [],
) {
  return { candidates, conflicts };
}

describe("validateJudgment", () => {
  test("fills ids from the batch and maps a conflict summary to a note", () => {
    const { result, errors } = validateJudgment(
      batch,
      judgment(undefined, [{ summary: "A or not A", entryIds: ["a1", "a2"] }]),
    );

    expect(errors).toEqual([]);
    expect(result?.candidates[0]).toEqual({
      clusterId: "c1",
      entryIds: ["a1", "a2"],
      sessionIds: ["s1"],
      title: "A",
      disposition: "watch",
      reason: "close read",
      matchesAdr: null,
    });
    expect(result?.conflicts).toEqual([
      { entryIds: ["a1", "a2"], note: "A or not A" },
    ]);
  });

  const c1 = {
    clusterId: "c1",
    title: "A",
    disposition: "promote",
    reason: "r",
  };
  const c2 = { clusterId: "c2", title: "B", disposition: "skip", reason: "r" };
  const invalid: [string, unknown, RegExp][] = [
    ["a missing cluster", judgment([c1]), /c2/],
    [
      "an unknown cluster",
      judgment([c1, c2, { ...c2, clusterId: "c9" }]),
      /c9/,
    ],
    ["a duplicate cluster", judgment([c1, c1, c2]), /c1/],
    [
      "a bad disposition",
      judgment([{ ...c1, disposition: "maybe" }, c2]),
      /disposition/,
    ],
    ["an empty reason", judgment([{ ...c1, reason: " " }, c2]), /reason/],
    [
      "a conflict on a non-watch cluster",
      judgment([c1, c2], [{ summary: "s", entryIds: ["a1"] }]),
      /watch/,
    ],
    [
      "a conflict entry outside the batch",
      judgment(
        [{ ...c1, disposition: "watch" }, c2],
        [{ summary: "s", entryIds: ["x9"] }],
      ),
      /x9/,
    ],
    [
      "an unknown matchesAdr",
      judgment([c1, { ...c2, matchesAdr: "ADR-0099" }]),
      /ADR-0099/,
    ],
    ["a non-object", "text", /candidates/],
  ];

  for (const [name, input, message] of invalid) {
    test(`rejects ${name}`, () => {
      const { result, errors } = validateJudgment(batch, input);

      expect(result).toBeNull();
      expect(errors.join("\n")).toMatch(message);
    });
  }
});

const run: RunMeta = {
  trailRoot: "/trail",
  adrDir: "/trail/docs/adr",
  nextAdr: 2,
  scan: { sessions: 2, entries: 3, clusters: 2, tooFresh: 0 },
  assignments: [
    { sessionId: "s1", target: "done", from: "inbox" },
    { sessionId: "s2", target: "done", from: "inbox" },
  ],
  batchCount: 1,
};

const recorded = validateJudgment(batch, judgment()).result as BatchResult;

describe("mergeTriage", () => {
  test("folds watch-wins into the assignments and builds the gate-1 payload", () => {
    const merged = mergeTriage(run, [batch], [recorded], []);

    expect(merged.errors).toEqual([]);
    expect(merged.assignments).toEqual([
      { sessionId: "s1", target: "watch", from: "inbox" },
      { sessionId: "s2", target: "done", from: "inbox" },
    ]);
    expect(merged.payload).toEqual({
      gate: 1,
      nextAdr: 2,
      candidates: [
        {
          entryIds: ["a1", "a2"],
          title: "A",
          reason: "close read",
          disposition: "watch",
          matchesAdr: null,
        },
        {
          entryIds: ["b1"],
          title: "B",
          reason: "Matches ADR-0001",
          disposition: "skip",
          matchesAdr: "ADR-0001",
        },
      ],
      conflicts: [],
      scan: { sessions: 2, entries: 3, clusters: 2, conflicts: 0, tooFresh: 0 },
    });
    expect(merged.ledger.indexOf("[watch]")).toBeLessThan(
      merged.ledger.indexOf("[skip]"),
    );
  });

  test("applies overrides by entryIds in order, the last one winning", () => {
    const merged = mergeTriage(
      run,
      [batch],
      [recorded],
      [
        {
          dispositions: [
            {
              entryIds: ["a2", "a1"],
              decision: "skip",
              reason: "In a comment",
            },
          ],
        },
        {
          dispositions: [
            { entryIds: ["a1", "a2"], decision: "promote", group: "g1" },
            { entryIds: ["b1"], decision: "skip" },
          ],
        },
      ],
    );

    expect(merged.errors).toEqual([]);
    expect(merged.payload.candidates[0]).toMatchObject({
      disposition: "promote",
      reason: "In a comment",
    });
    expect(merged.assignments.map(({ target }) => target)).toEqual([
      "done",
      "done",
    ]);
  });

  test("rejects an override that names no candidate or a bad decision", () => {
    const merged = mergeTriage(
      run,
      [batch],
      [recorded],
      [
        { dispositions: [{ entryIds: ["zzz"], decision: "skip" }] },
        { dispositions: [{ entryIds: ["b1"], decision: "maybe" }] },
      ],
    );

    expect(merged.errors.join("\n")).toMatch(/zzz/);
    expect(merged.errors.join("\n")).toMatch(/maybe/);
  });

  test("reports a batch with no result", () => {
    expect(mergeTriage(run, [batch], [null], []).errors.join()).toMatch(
      /batch 1/,
    );
  });

  test("a fallback result turns a failed batch into watch, naming the failure", () => {
    const merged = mergeTriage(run, [batch], [fallbackResult(batch)], []);

    expect(merged.errors).toEqual([]);
    expect(
      merged.payload.candidates.map(({ disposition }) => disposition),
    ).toEqual(["watch", "watch"]);
    expect(merged.payload.candidates[0]?.reason).toContain("batch 1");
    expect(merged.assignments.map(({ target }) => target)).toEqual([
      "watch",
      "watch",
    ]);
  });
});

describe("CLI", () => {
  const script = join(import.meta.dir, "triage.ts");
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function scratch(): string {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "triage-")));
    directories.push(directory);
    return directory;
  }

  function cli(cwd: string, args: string[], input?: string) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      input,
    });
  }

  function writeLog(
    root: string,
    sessionId: string,
    entries: [string, string][],
  ) {
    const path = join(root, ".cockpit", "logs", `${sessionId}.jsonl`);
    const lines = entries.map(([id, decision]) =>
      JSON.stringify({
        id,
        type: "decision",
        kind: "decision",
        decision,
        reason: "r",
        tradeoff: "t",
        facets: [],
        needs_your_call: false,
        options: [],
        files: [],
        timestamp: "2026-09-10T00:00:00Z",
      }),
    );
    writeFileSync(path, `${lines.join("\n")}\n`);
    const date = new Date(Date.now() - STALE_MS - 1_000);
    utimesSync(path, date, date);
  }

  test("prep reports no trail without writing a run", () => {
    const result = cli(scratch(), ["prep"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ hasTrail: false });
  });

  test("prep, record, and merge produce the gate-1 payload and the archive plan", () => {
    const root = scratch();
    mkdirSync(join(root, ".cockpit", "logs"), { recursive: true });
    writeLog(root, "s1", [["a", "A"]]);
    writeLog(root, "s2", [
      ["b", "A"],
      ["c", "B"],
    ]);

    const prep = cli(root, ["prep"]);
    expect(prep.status).toBe(0);
    const summary = JSON.parse(prep.stdout);
    directories.push(summary.runDir);
    expect(summary).toMatchObject({
      hasTrail: true,
      nextAdr: 1,
      sessions: 2,
      entries: 3,
      clusters: 2,
      tooFresh: 0,
    });
    expect(summary.batches).toHaveLength(1);

    const batchPath = summary.batches[0];
    expect(cli(root, ["record", "--batch", batchPath], "{}").status).toBe(1);
    const valid = JSON.stringify({
      candidates: [
        {
          clusterId: "c1",
          title: "A",
          disposition: "promote",
          reason: "durable",
        },
        { clusterId: "c2", title: "B", disposition: "skip", reason: "local" },
      ],
      conflicts: [],
    });
    const record = cli(root, ["record", "--batch", batchPath], valid);
    expect(record.status).toBe(0);
    expect(JSON.parse(record.stdout)).toMatchObject({
      promote: 1,
      watch: 0,
      skip: 1,
    });
    expect(cli(root, ["record", "--batch", batchPath], valid).status).toBe(1);

    const merge = cli(root, ["merge", "--run", summary.runDir]);
    expect(merge.status).toBe(0);
    const merged = JSON.parse(merge.stdout);
    const payload = JSON.parse(readFileSync(merged.gate1Path, "utf8"));
    expect(
      payload.candidates.map(
        ({ entryIds }: { entryIds: string[] }) => entryIds,
      ),
    ).toEqual([["a", "b"], ["c"]]);
    const plan = JSON.parse(readFileSync(merged.planPath, "utf8"));
    expect(plan.moves.map(({ target }: { target: string }) => target)).toEqual([
      "done",
      "done",
    ]);

    const elsewhere = scratch();
    mkdirSync(join(elsewhere, ".cockpit", "logs"), { recursive: true });
    expect(cli(elsewhere, ["merge", "--run", summary.runDir]).status).toBe(1);
  });

  test("merge --missing-as-watch persists the fallback for every later merge", () => {
    const root = scratch();
    mkdirSync(join(root, ".cockpit", "logs"), { recursive: true });
    writeLog(root, "s1", [["a", "A"]]);
    const summary = JSON.parse(cli(root, ["prep"]).stdout);
    directories.push(summary.runDir);

    expect(cli(root, ["merge", "--run", summary.runDir]).status).toBe(1);
    expect(
      cli(root, ["merge", "--run", summary.runDir, "--missing-as-watch"])
        .status,
    ).toBe(0);

    const overrides = join(summary.runDir, "gate1-response.json");
    writeFileSync(
      overrides,
      JSON.stringify({ dispositions: [{ entryIds: ["a"], decision: "skip" }] }),
    );
    const remerge = cli(root, [
      "merge",
      "--run",
      summary.runDir,
      "--overrides",
      overrides,
    ]);
    expect(remerge.status).toBe(0);
    expect(JSON.parse(remerge.stdout)).toMatchObject({ watch: 0, skip: 1 });

    const late = JSON.stringify({
      candidates: [
        { clusterId: "c1", title: "A", disposition: "promote", reason: "late" },
      ],
      conflicts: [],
    });
    expect(
      cli(root, ["record", "--batch", summary.batches[0]], late).status,
    ).toBe(1);
  });

  test("prep --evidence clusters a fresh session and assigns nothing", () => {
    const root = scratch();
    mkdirSync(join(root, ".cockpit", "logs"), { recursive: true });
    writeLog(root, "s1", [["a", "A"]]);
    const now = new Date();
    utimesSync(join(root, ".cockpit", "logs", "s1.jsonl"), now, now);

    const summary = JSON.parse(cli(root, ["prep", "--evidence"]).stdout);
    directories.push(summary.runDir);

    expect(summary).toMatchObject({ clusters: 1, tooFresh: 0 });
    const run = JSON.parse(
      readFileSync(join(summary.runDir, "run.json"), "utf8"),
    );
    expect(run.assignments).toEqual([]);
  });
});
