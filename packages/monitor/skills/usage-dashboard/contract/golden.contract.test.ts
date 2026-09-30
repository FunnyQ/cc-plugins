// Regenerating golden files now means writing Rust output over them and reviewing that diff by hand: no reference implementation remains.
// Golden suite: the Rust binary must reproduce the TS outputs recorded here before the TS was deleted. Test names are frozen — every port's
// verification filters on them with `bun test <file> -t "<name>"`.
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import {
  APPENDED_LINES,
  ROLLUP_TABLES,
  SCENARIOS,
  SCENARIO_MTIME_MS,
  SOURCES,
  STATS_KEYS,
  V2_SEED_HOURLY,
  dumpRollup,
  fixtureRoot,
  incrementalAppend,
  loadVolatileKeys,
  migrateV2,
  normalizeFixturePaths,
  readGolden,
  readMeta,
  rebuild,
  recordRollupTables,
  recordSource,
  recordStats,
  refuseNewer,
  rollupDbPath,
  rollupUpdate,
  stripVolatile,
  transcriptDeleted,
  withFixture,
  type Dump,
  type Row,
} from "./golden";

// One line per volatile-keys.json entry: why it differs between two recordings.
const VOLATILE_REASONS: Record<string, string> = {
  "dataHealth.sources.6.modifiedAt":
    "the Codex usage cache is written by the run itself, so its mtime is the wall clock",
};

// Each run spawns a process against a fresh fixture home.
const SPAWN_TIMEOUT_MS = 60_000;

const scenarioGolden = (name: keyof typeof SCENARIOS) =>
  readGolden<Dump>("rollup", `${SCENARIOS[name]}.json`);

const rowKey = (r: Row) => JSON.stringify([r.hour_ms, r.project, r.model]);

describe("golden helpers", () => {
  test("normalizeFixturePaths rewrites nested values and path keys", () => {
    const root = "/tmp/atlas-fixture-abc";
    const input: Record<string, unknown> = {
      path: `${root}/home/a.jsonl`,
      projectTokens: { [`${root}/home/proj`]: 3, "/work/proj-a": 1 },
      history: {
        byProject: { [`${root}/x`]: [{ file: `${root}/x/y`, n: 2 }] },
      },
      list: [`${root}`, "untouched", 7, null],
    };
    expect(normalizeFixturePaths(input, root)).toEqual({
      path: "<FIXTURE>/home/a.jsonl",
      projectTokens: { "<FIXTURE>/home/proj": 3, "/work/proj-a": 1 },
      history: {
        byProject: { "<FIXTURE>/x": [{ file: "<FIXTURE>/x/y", n: 2 }] },
      },
      list: ["<FIXTURE>", "untouched", 7, null],
    });
  });

  test("stripVolatile deletes dotted paths with * over keys and indexes", () => {
    const value: Record<string, unknown> = {
      a: { b: 1, c: 2 },
      list: [
        { t: 1, keep: true },
        { t: 2, keep: true },
      ],
    };
    stripVolatile(value, ["a.b", "list.*.t", "missing.path"]);
    expect(value).toEqual({
      a: { c: 2 },
      list: [{ keep: true }, { keep: true }],
    });
  });

  test("every volatile key carries a reason", async () => {
    expect(Object.keys(VOLATILE_REASONS)).toEqual(await loadVolatileKeys());
  });
});

describe("golden stats", () => {
  let actual: Record<string, unknown>;
  let golden: Record<string, unknown>;
  beforeAll(async () => {
    [actual, golden] = await Promise.all([
      recordStats(),
      readGolden<Record<string, unknown>>("stats.json"),
    ]);
  }, SPAWN_TIMEOUT_MS);

  test("stats top-level key order", () => {
    expect(Object.keys(actual)).toEqual([...STATS_KEYS]);
  });

  for (const key of STATS_KEYS) {
    test(`stats key ${key}`, () => {
      expect(actual[key]).toEqual(golden[key]);
    });
  }
});

describe("golden sources", () => {
  for (const name of SOURCES) {
    test(
      `source ${name}`,
      async () => {
        expect(await recordSource(name)).toEqual(
          await readGolden("sources", `${name}.json`),
        );
      },
      SPAWN_TIMEOUT_MS,
    );
  }
});

describe("golden rollup", () => {
  let dump: Dump;
  beforeAll(async () => {
    dump = await recordRollupTables();
  }, SPAWN_TIMEOUT_MS);

  for (const table of ROLLUP_TABLES) {
    test(`rollup table ${table}`, async () => {
      expect(dump[table]).toEqual(await readGolden("rollup", `${table}.json`));
    });
  }

  test(
    "rollup incremental append",
    async () => {
      const { before, after, path, size } = await incrementalAppend();
      const file = after.ingested_files.find((r) => r.path === path);
      expect(file).toEqual({
        path,
        bytes_parsed: size,
        mtime_ms: SCENARIO_MTIME_MS,
      });
      // The repeated req_B1 snapshot bills nothing: only req_B3's bucket is new.
      const old = new Set(before.usage_hourly.map(rowKey));
      expect(before.usage_hourly).toEqual(
        after.usage_hourly.filter((r) => old.has(rowKey(r))),
      );
      const last = APPENDED_LINES.at(-1)!;
      expect(after.usage_hourly.filter((r) => !old.has(rowKey(r)))).toEqual([
        {
          hour_ms: Date.parse("2026-09-28T23:00:00+08:00"),
          project: last.cwd,
          model: last.message.model,
          input_tokens: 60,
          output_tokens: 120,
          cache_read: 1500,
          cache_creation: 0,
          reasoning: 0,
          message_count: 1,
        },
      ]);
      expect(after).toEqual(await scenarioGolden("incremental append"));
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rollup transcript deleted",
    async () => {
      const { before, after, path } = await transcriptDeleted();
      expect(before.session_ledger.some((r) => r.path === path)).toBe(true);
      // Token history outlives the transcript; the ledger prunes with it.
      expect(after.usage_hourly).toEqual(before.usage_hourly);
      for (const table of [
        "session_ledger",
        "session_model_usage",
        "ingested_files",
      ] as const) {
        expect(after[table].filter((r) => r.path === path)).toEqual([]);
      }
      const liveSessions = new Set(
        after.session_ledger.map((r) => r.session_key),
      );
      expect(
        after.seen_tool_calls.filter((r) => !liveSessions.has(r.session_key)),
      ).toEqual([]);
      // msg_A1's tool call lived only in the deleted file.
      expect(after.seen_tool_calls.map((r) => r.tool_key)).not.toContain(
        "msg_A1",
      );
      expect(after).toEqual(await scenarioGolden("transcript deleted"));
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rollup rebuild",
    async () => {
      const { before, after } = await rebuild();
      expect(after.usage_hourly).toEqual(before.usage_hourly);
      expect(after.session_ledger).toEqual(before.session_ledger);
      expect(after.session_model_usage).toEqual(before.session_model_usage);
      expect(after.session_ledger).toEqual(
        await readGolden("rollup", "session_ledger.json"),
      );
      expect(after.session_model_usage).toEqual(
        await readGolden("rollup", "session_model_usage.json"),
      );
      expect(after).toEqual(await scenarioGolden("rebuild"));
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rollup migrate v2",
    async () => {
      const { after, run, backupExists, schemaVersion } = await migrateV2();
      expect(run.code).toBe(0);
      expect(backupExists).toBe(true);
      expect(schemaVersion).toBe("3");
      // Survive unchanged: the legacy row has no transcript, and seen_requests blocks re-billing B's.
      for (const row of V2_SEED_HOURLY)
        expect(after.usage_hourly).toContainEqual(row);
      expect(after.session_ledger.length).toBeGreaterThan(0);
      expect(after).toEqual(await scenarioGolden("migrate v2"));
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rollup refuse newer",
    async () => {
      const { before, after, run, backupExists } = await refuseNewer();
      expect(run.code).not.toBe(0);
      expect(run.err).toContain("Unsupported rollup schema version: 99");
      expect(after).toEqual(before);
      // The TS takes its version backup before the version check.
      expect(backupExists).toBe(true);
      expect(after).toEqual(await scenarioGolden("refuse newer"));
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rollup pre-rust backup",
    async () => {
      await withFixture(async (f) => {
        const db = rollupDbPath(f);
        const bak = `${db}.pre-rust.bak`;
        const ingest = async () =>
          expect((await rollupUpdate(f, db)).code).toBe(0);

        await ingest();
        expect(existsSync(bak)).toBe(false);
        expect(readMeta(db, "writer")).toBe("rust");

        const edit = new Database(db);
        edit.query("DELETE FROM meta WHERE key = 'writer'").run();
        edit.close();
        const preIngest = dumpRollup(db, fixtureRoot(f));

        await ingest();
        expect(existsSync(bak)).toBe(true);
        expect(dumpRollup(bak, fixtureRoot(f))).toEqual(preIngest);
        expect(readMeta(bak, "writer")).toBeNull();
        expect(readMeta(db, "writer")).toBe("rust");

        const bakMtime = statSync(bak).mtimeMs;
        await ingest();
        expect(statSync(bak).mtimeMs).toBe(bakMtime);
      });
    },
    SPAWN_TIMEOUT_MS,
  );
});
