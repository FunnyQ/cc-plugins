import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";

import type { AttemptRow } from "./attempt";
import { dbPath, insert, open, parseRow } from "./lessons-db";

const ROW: AttemptRow = {
  prompt: "can you checking the logs",
  english: 0.92,
  improve: 0.81,
  englishMin: 0.7,
  improveMin: 0.6,
  outcome: "shown",
  better: "can you check the logs",
  quip: "verbs, not gerunds",
  system: "You are Clawd.",
  at: "2026-10-27T10:00:00.000Z",
  project: "cc-plugins",
  session: "abc123",
  model: "haiku",
  effort: "low",
};

const CLI = join(import.meta.dir, "lessons-cli.ts");

let dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "lessons-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const record = (home: string, stdin: string, args = ["record"]) =>
  Bun.spawn(["bun", CLI, ...args], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  });

const run = async (home: string, stdin: string, args = ["record"]) => {
  const p = record(home, stdin, args);
  const [code, stderr] = await Promise.all([
    p.exited,
    new Response(p.stderr).text(),
  ]);
  return { code, stderr: stderr.trim() };
};

describe("insert", () => {
  test("round trip stores every column, null scores as NULL, labels NULL", () => {
    const db = open(dbPath(temp()));
    insert(db, ROW);
    insert(db, { ...ROW, english: null, improve: null, outcome: "jev-failed" });
    const rows = db.query("SELECT * FROM attempts ORDER BY id").all();
    db.close();
    expect(rows).toEqual([
      {
        id: 1,
        at: ROW.at,
        project: ROW.project,
        session: ROW.session,
        prompt: ROW.prompt,
        english: 0.92,
        improve: 0.81,
        english_min: 0.7,
        improve_min: 0.6,
        outcome: "shown",
        better: ROW.better,
        quip: ROW.quip,
        model: "haiku",
        effort: "low",
        system_hash: expect.any(String),
        needs: null,
        verdict: null,
        note: null,
        labeled_at: null,
      },
      expect.objectContaining({
        id: 2,
        english: null,
        improve: null,
        outcome: "jev-failed",
        needs: null,
        verdict: null,
        note: null,
        labeled_at: null,
      }),
    ]);
  });

  test("system_hash is the first 12 hex of sha256(system) and system is not stored", () => {
    const db = open(dbPath(temp()));
    insert(db, ROW);
    const row = db.query("SELECT * FROM attempts").get() as Record<
      string,
      unknown
    >;
    db.close();
    expect(row.system_hash).toBe(
      createHash("sha256").update(ROW.system).digest("hex").slice(0, 12),
    );
    expect(Object.values(row)).not.toContain(ROW.system);
  });
});

describe("parseRow", () => {
  const without = (key: keyof AttemptRow) => {
    const r: Record<string, unknown> = { ...ROW };
    delete r[key];
    return JSON.stringify(r);
  };
  const withField = (key: string, value: unknown) =>
    JSON.stringify({ ...ROW, [key]: value });

  test("accepts a valid row and null scores", () => {
    expect(parseRow(JSON.stringify(ROW))).toEqual(ROW);
    expect(parseRow(withField("english", null)).english).toBeNull();
  });

  test("refuses an unknown outcome", () => {
    expect(() => parseRow(withField("outcome", "bogus"))).toThrow();
  });

  for (const key of [
    "at",
    "project",
    "session",
    "prompt",
    "model",
    "effort",
    "system",
  ])
    test(`refuses a non-string ${key}`, () => {
      expect(() => parseRow(withField(key, 1))).toThrow();
    });

  test("refuses a non-number englishMin", () => {
    expect(() => parseRow(withField("englishMin", "0.7"))).toThrow();
  });

  test("refuses an english that is neither a number nor null", () => {
    expect(() => parseRow(withField("english", "0.5"))).toThrow();
  });

  test("refuses a better that is neither a string nor null", () => {
    expect(() => parseRow(withField("better", 5))).toThrow();
  });

  test("refuses a missing quip", () => {
    expect(() => parseRow(without("quip"))).toThrow();
  });

  test("lets a JSON error propagate", () => {
    expect(() => parseRow("{not json")).toThrow(SyntaxError);
  });
});

describe("open", () => {
  test("refuses a newer schema and leaves the journal mode alone", () => {
    const path = dbPath(temp());
    mkdirSync(dirname(path), { recursive: true });
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 2");
    raw.close();

    expect(() => open(path)).toThrow(
      "lessons.db schema v2 is newer than this runes build",
    );

    const check = new DatabaseSync(path);
    const mode = check.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    check.close();
    expect(mode.journal_mode).toBe("delete");
  });

  test("makes the directory private, new or pre-made", () => {
    const old = process.umask(0o022);
    try {
      const fresh = dbPath(temp());
      open(fresh).close();
      expect(statSync(dirname(fresh)).mode & 0o777).toBe(0o700);

      const premade = dbPath(temp());
      mkdirSync(dirname(premade), { recursive: true, mode: 0o755 });
      expect(statSync(dirname(premade)).mode & 0o777).toBe(0o755);
      open(premade).close();
      expect(statSync(dirname(premade)).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(old);
    }
  });

  test("reopening a v1 file keeps its version, rows, and single table", () => {
    const path = dbPath(temp());
    const first = open(path);
    insert(first, ROW);
    first.close();

    const db = open(path);
    const version = db.query("PRAGMA user_version").get();
    const count = db.query("SELECT count(*) AS n FROM attempts").get();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    db.close();
    expect(version).toEqual({ user_version: 1 });
    expect(count).toEqual({ n: 1 });
    expect(tables).toEqual([{ name: "attempts" }]);
  });
});

describe("lessons-cli.ts", () => {
  test("two concurrent records on a fresh file both keep their row, 20 rounds", async () => {
    for (let round = 0; round < 20; round++) {
      const home = temp();
      const children = [
        record(home, JSON.stringify(ROW)),
        record(home, JSON.stringify({ ...ROW, session: "def456" })),
      ];
      const results = await Promise.all(
        children.map(async (p) => ({
          code: await p.exited,
          stderr: await new Response(p.stderr).text(),
        })),
      );
      expect(results).toEqual([
        { code: 0, stderr: "" },
        { code: 0, stderr: "" },
      ]);
      const db = new DatabaseSync(dbPath(home));
      const count = db.prepare("SELECT count(*) AS n FROM attempts").get();
      db.close();
      expect({ ...count }).toEqual({ n: 2 });
    }
  }, 60_000);

  test("record exits 0 on a valid row", async () => {
    expect(await run(temp(), JSON.stringify(ROW))).toEqual({
      code: 0,
      stderr: "",
    });
  });

  test("no subcommand exits 2 with usage", async () => {
    expect(await run(temp(), "", [])).toEqual({
      code: 2,
      stderr: "usage: lessons-cli.ts record|label|stats",
    });
  });

  test("an unknown subcommand exits 2 with usage", async () => {
    expect(await run(temp(), "", ["bogus"])).toEqual({
      code: 2,
      stderr: "usage: lessons-cli.ts record|label|stats",
    });
  });

  test("an empty HOME exits 1 before opening anything", async () => {
    expect(await run("", JSON.stringify(ROW))).toEqual({
      code: 1,
      stderr: "lessons-cli.ts: HOME is not set",
    });
  });

  test("invalid JSON exits 1", async () => {
    const r = await run(temp(), "{not json");
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
  });

  test("a bad row exits 1 with the parseRow message", async () => {
    expect(
      await run(temp(), JSON.stringify({ ...ROW, outcome: "bogus" })),
    ).toEqual({ code: 1, stderr: "unknown outcome: bogus" });
  });
});
