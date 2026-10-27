import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";

import type { AttemptRow } from "./attempt";
import {
  dbPath,
  insert,
  label,
  open,
  parseRow,
  stats,
  unlabeled,
} from "./lessons-db";

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
    cwd: temp(),
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

const AT = "2026-10-27T11:00:00.000Z";

const seed = () => {
  const home = temp();
  const db = open(dbPath(home));
  const base = { ...ROW, model: "haiku", effort: "low", system: "S" };
  const fixture: [
    AttemptRow["outcome"],
    number | null,
    number | null,
    number,
    string | null,
  ][] = [
    ["gated", 0.4, 0.68, 0.7, null],
    ["shown", 0.68, 0.88, 0.7, "B2"],
    ["gated", 0.92, 0.52, 0.7, null],
    ["gated", 0.62, 0.52, 0.7, null],
    ["shown", 0.82, 0.68, 0.7, "B5"],
    ["gated", 0.78, 0.97, 0.7, null],
    ["jev-failed", null, null, 0.7, null],
    ["gated", 0.9, 0.9, 0.75, null],
    ["not-rewrite", 0.85, 0.75, 0.75, "B9"],
  ];
  for (const [outcome, english, improve, englishMin, better] of fixture)
    insert(db, {
      ...base,
      outcome,
      english,
      improve,
      englishMin,
      improveMin: 0.6,
      better,
      quip: null,
    });
  const labels: [0 | 1 | null, "good" | "bad-gate" | null][] = [
    [1, null],
    [1, "good"],
    [1, null],
    [0, null],
    [0, "bad-gate"],
    [0, null],
    [1, null],
    [null, null],
  ];
  labels.forEach(([needs, verdict], k) =>
    expect(label(db, k + 1, { needs, verdict, note: null }, AT)).toBe(true),
  );
  return { home, db };
};

const expectCut = (
  c: Record<string, number> | null,
  want: Record<string, number>,
) => {
  expect(c).not.toBeNull();
  for (const [k, v] of Object.entries(want)) expect(c![k]).toBeCloseTo(v, 9);
};

describe("unlabeled and label", () => {
  test("unlabeled returns only id 9 in the fixture", () => {
    const { db } = seed();
    expect(unlabeled(db).map((r) => r.id)).toEqual([9]);
    expect(unlabeled(db)[0]).toEqual({
      id: 9,
      at: ROW.at,
      project: ROW.project,
      outcome: "not-rewrite",
      english: 0.85,
      improve: 0.75,
      prompt: ROW.prompt,
      better: "B9",
      quip: null,
    });
    db.close();
  });

  test("unlabeled orders by id", () => {
    const db = open(dbPath(temp()));
    insert(db, ROW);
    insert(db, ROW);
    insert(db, ROW);
    expect(unlabeled(db).map((r) => r.id)).toEqual([1, 2, 3]);
    db.close();
  });

  test("label refuses an already-labeled row and changes nothing", () => {
    const { db } = seed();
    expect(
      label(db, 2, { needs: 0, verdict: "bad-model", note: "x" }, "later"),
    ).toBe(false);
    expect(
      db
        .query("SELECT needs, verdict, note, labeled_at FROM attempts WHERE id = 2")
        .get(),
    ).toEqual({ needs: 1, verdict: "good", note: null, labeled_at: AT });
    db.close();
  });
});

describe("stats", () => {
  test("fixed sample: sample, variants, current, sweep", () => {
    const { db } = seed();
    const s = stats(db, { english: 0.7, improve: 0.6 });
    db.close();
    const hash = createHash("sha256").update("S").digest("hex").slice(0, 12);
    expect(s.sample).toBe(6);
    expect(s.variants).toEqual([
      {
        model: "haiku",
        effort: "low",
        systemHash: hash,
        englishMin: 0.7,
        improveMin: 0.6,
        rows: 7,
        shown: 2,
        labeled: 7,
        good: 1,
        judged: 2,
      },
      {
        model: "haiku",
        effort: "low",
        systemHash: hash,
        englishMin: 0.75,
        improveMin: 0.6,
        rows: 2,
        shown: 0,
        labeled: 1,
        good: 0,
        judged: 0,
      },
    ]);
    expectCut(s.current, {
      english: 0.7,
      improve: 0.6,
      tp: 0,
      fp: 2,
      fn: 3,
      tn: 1,
      accuracy: 1 / 6,
      precision: 0,
      recall: 0,
    });
    const want = [
      [0.85, 0.5, 1, 0, 2, 3, 4 / 6, 1, 1 / 3],
      [0.9, 0.5, 1, 0, 2, 3, 4 / 6, 1, 1 / 3],
      [0.65, 0.5, 2, 2, 1, 1, 3 / 6, 2 / 4, 2 / 3],
      [0.5, 0.7, 1, 1, 2, 2, 3 / 6, 1 / 2, 1 / 3],
      [0.5, 0.75, 1, 1, 2, 2, 3 / 6, 1 / 2, 1 / 3],
    ];
    expect(s.sweep).toHaveLength(5);
    want.forEach((w, k) => {
      const [english, improve, tp, fp, fn, tn, accuracy, precision, recall] = w;
      expectCut(s.sweep[k], {
        english,
        improve,
        tp,
        fp,
        fn,
        tn,
        accuracy,
        precision,
        recall,
      });
    });
  });

  test("a cut predicting nothing gives zero precision and recall", () => {
    const { db } = seed();
    const s = stats(db, { english: 0.99, improve: 0.99 });
    db.close();
    expectCut(s.current, {
      tp: 0,
      fp: 0,
      fn: 3,
      tn: 3,
      precision: 0,
      recall: 0,
      accuracy: 0.5,
    });
  });

  test("an empty database", () => {
    const db = open(dbPath(temp()));
    expect(stats(db, { english: 0.7, improve: 0.6 })).toEqual({
      variants: [],
      sweep: [],
      current: null,
      sample: 0,
    });
    db.close();
  });
});

const cli = async (home: string, stdin: string, args: string[]) => {
  const p = record(home, stdin, args);
  const [code, stdout] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
  ]);
  return { code, stdout };
};

const labels = (home: string) => {
  const db = open(dbPath(home));
  const rows = db
    .query(
      "SELECT id, needs, verdict, note, labeled_at IS NOT NULL AS done FROM attempts ORDER BY id",
    )
    .all();
  db.close();
  return rows;
};

describe("lessons-cli.ts label", () => {
  const three = () => {
    const home = temp();
    const db = open(dbPath(home));
    insert(db, { ...ROW, outcome: "shown", better: "Fix it." });
    insert(db, { ...ROW, outcome: "gated", better: null });
    insert(db, { ...ROW, outcome: "shown" });
    db.close();
    return home;
  };

  test("re-asks, labels, skips, and quits without touching the current row", async () => {
    const home = three();
    const r = await cli(home, "x\ny\ng\nnice\ns\nq\n", ["label"]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("needs? ").length - 1).toBe(4);
    expect(labels(home)).toEqual([
      { id: 1, needs: 1, verdict: "good", note: "nice", done: 1 },
      { id: 2, needs: null, verdict: null, note: null, done: 1 },
      { id: 3, needs: null, verdict: null, note: null, done: 0 },
    ]);
  });

  test("a row with no better is never asked for a verdict", async () => {
    const home = temp();
    const db = open(dbPath(home));
    insert(db, { ...ROW, outcome: "gated", better: null, quip: null });
    db.close();
    const r = await cli(home, "n\n\n", ["label"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("verdict?");
    expect(r.stdout).not.toContain("better:");
    expect(labels(home)).toEqual([
      { id: 1, needs: 0, verdict: null, note: null, done: 1 },
    ]);
  });

  test("EOF exits 0 and leaves the current row untouched", async () => {
    const home = three();
    const r = await cli(home, "y\n", ["label"]);
    expect(r.code).toBe(0);
    expect(labels(home).map((x) => (x as { done: number }).done)).toEqual([
      0, 0, 0,
    ]);
  });

  test("q at the verdict or note prompt quits without touching the current row", async () => {
    for (const stdin of ["y\nq\n", "y\ng\nq\n"]) {
      const home = three();
      const r = await cli(home, stdin, ["label"]);
      expect(r.code).toBe(0);
      expect(labels(home).map((x) => (x as { done: number }).done)).toEqual([
        0, 0, 0,
      ]);
    }
  });

  test("control characters print escaped", async () => {
    const home = temp();
    const db = open(dbPath(home));
    insert(db, { ...ROW, prompt: "\x1b]52;c;aGk=\x07" });
    db.close();
    const r = await cli(home, "q\n", ["label"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("prompt: \\x1b]52;c;aGk=\\x07");
    expect(r.stdout).not.toContain("\x1b");
  });

  test("an empty database prints no unlabeled rows", async () => {
    const home = temp();
    open(dbPath(home)).close();
    expect(await cli(home, "", ["label"])).toEqual({
      code: 0,
      stdout: "no unlabeled rows\n",
    });
  });
});

describe("lessons-cli.ts stats", () => {
  test("prints the fixed sample", async () => {
    const { home, db } = seed();
    db.close();
    const r = await cli(home, "", ["stats"]);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("sample\t6\n")).toBe(true);
    const lines = r.stdout.split("\n");
    const v = lines.indexOf("variants");
    const s = lines.indexOf("sweep");
    const c = lines.indexOf("current");
    expect(0 < v && v < s && s < c).toBe(true);
    expect(lines[s + 2]).toBe("0.85\t0.50\t1\t0\t2\t3\t0.667\t1.000\t0.333");
    expect(lines[v + 2]).toBe(
      `haiku\tlow\t${createHash("sha256").update("S").digest("hex").slice(0, 12)}\t0.70\t0.60\t7\t2\t7\t1/2`,
    );
    expect(lines[c + 2]).toBe("0.70\t0.60\t0\t2\t3\t1\t0.167\t0.000\t0.000");
  });

  test("an empty database prints current none", async () => {
    const r = await cli(temp(), "", ["stats"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("current\tnone");
  });
});
